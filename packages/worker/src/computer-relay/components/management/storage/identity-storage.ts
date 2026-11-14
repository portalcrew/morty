import type { SessionAccessHolder } from "@morty-build/client/protocol";
import { and, eq, exists, gt, inArray, isNull, max, ne, notExists, or, type SQL, sql } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Credential, SharedLinkTerms } from "../../../../contracts/authentication/credential.ts";
import type { ClientLocation } from "../../../../contracts/client-location.ts";
import { readTransferCredential } from "../../../../contracts/transfer-credential.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import {
    browserCredential,
    browserDevice,
    continueLink,
    linkSharedByDevice,
    linkSharedByOwner,
    ownerCredential,
} from "../../../schema/computer-relay-do/index.ts";
import { type AnonymousIdentity, digest } from "./identity-storage-common.ts";

type IdentityDatabase = DurableObjectDatabase["orm"];

/** A link no device has used yet: it issued no credential. */
function unusedLink(database: IdentityDatabase, linkId: SQLiteColumn = continueLink.id) {
    return notExists(
        database
            .select({ id: browserCredential.id })
            .from(browserCredential)
            .where(eq(browserCredential.transferId, linkId)),
    );
}
const openedCredential = alias(browserCredential, "opened_credential");
const openedLink = alias(continueLink, "opened_link");
const successorLink = alias(continueLink, "successor_link");
const predecessorLink = alias(continueLink, "predecessor_link");

/**
 * The one rule for a link the owner still stands by: they did not cancel it, no newer link replaced it, and it is
 * not past the time it can add a device. What follows from the access that shared it is read from that access.
 */
function linkInForce(
    database: IdentityDatabase,
    now: number,
    link: {
        readonly id: SQLiteColumn;
        readonly cancelledAt: SQLiteColumn;
        readonly expiresAt: SQLiteColumn;
    } = continueLink,
) {
    return and(
        isNull(link.cancelledAt),
        gt(link.expiresAt, now),
        notExists(
            database
                .select({ id: successorLink.id })
                .from(successorLink)
                .where(eq(successorLink.replacesTransferId, link.id)),
        ),
    );
}

/**
 * Cancels this Computer's invitations no device has used yet; a cancelled link stays cancelled. `by` is the access the
 * cancelling is done under, checked in the write itself.
 */
function cancelUnusedLinks(database: IdentityDatabase, now: number, by: SQL) {
    return database
        .update(continueLink)
        .set({ cancelledAt: now })
        .where(and(isNull(continueLink.cancelledAt), unusedLink(database), by));
}
const successorCredential = alias(ownerCredential, "successor_credential");
const heldDevice = alias(browserDevice, "held_device");

/**
 * A browser device's term: the latest among the links the device opened, so opening another link never shortens it.
 * Null only for a device that opened none.
 */
function deviceTerm(database: IdentityDatabase, deviceId: SQLiteColumn) {
    return sql<number | null>`(${database
        .select({ term: max(openedLink.accessExpiresAt) })
        .from(openedCredential)
        .innerJoin(openedLink, eq(openedLink.id, openedCredential.transferId))
        .where(eq(openedCredential.deviceId, deviceId))})`;
}

/**
 * The one rule for a browser device's access: it holds until its term unless it was ended first, and ended access
 * never resumes. Revoking a link only stops it from adding a device; it never ends a device's access. The value is
 * the term while the device holds access and null once it does not, so every reader and writer applies this rule.
 */
function deviceAccessHeldUntil(
    database: IdentityDatabase,
    device: { readonly id: SQLiteColumn; readonly endedAt: SQLiteColumn },
    now: number,
) {
    const term = deviceTerm(database, device.id);
    return sql<number | null>`(CASE WHEN ${device.endedAt} IS NULL AND ${term} > ${now} THEN ${term} END)`;
}

/** The browser device `deviceId` holds access: it did not end and its term has not passed. */
function deviceAccessHeld(database: IdentityDatabase, deviceId: SQLiteColumn, now: number) {
    return exists(
        database
            .select({ id: heldDevice.id })
            .from(heldDevice)
            .where(
                and(eq(heldDevice.id, deviceId), sql`${deviceAccessHeldUntil(database, heldDevice, now)} IS NOT NULL`),
            ),
    );
}

/** The browser credential's device holds access; replacing the credential keeps the device and its access. */
function browserAccessHeld(database: IdentityDatabase, now: number) {
    return deviceAccessHeld(database, browserCredential.deviceId, now);
}

/** A browser credential that authenticates now: no newer credential of its device replaced it, and the device holds. */
function browserCredentialInForce(database: IdentityDatabase, now: number) {
    return and(isNull(browserCredential.replacedAt), browserAccessHeld(database, now));
}

/** The one rule for the computer's own credential: it holds its own access until it is revoked. */
function ownerAccessHeld(credential: { readonly revokedAt: SQLiteColumn } = ownerCredential) {
    return isNull(credential.revokedAt);
}

const sharerOwnerCredential = alias(ownerCredential, "sharer_owner_credential");

/**
 * The access that shared the link still holds: the device's, which opening another link never ends, or the computer's
 * own credential's. A link adds no device once it does not, so ending that access needs no separate write to void the
 * link.
 */
function linkSharerHolds(database: IdentityDatabase, linkId: SQLiteColumn, now: number) {
    return or(
        exists(
            database
                .select({ id: linkSharedByOwner.linkId })
                .from(linkSharedByOwner)
                .innerJoin(sharerOwnerCredential, eq(sharerOwnerCredential.id, linkSharedByOwner.ownerCredentialId))
                .where(and(eq(linkSharedByOwner.linkId, linkId), ownerAccessHeld(sharerOwnerCredential))),
        ),
        exists(
            database
                .select({ id: linkSharedByDevice.linkId })
                .from(linkSharedByDevice)
                .where(
                    and(
                        eq(linkSharedByDevice.linkId, linkId),
                        deviceAccessHeld(database, linkSharedByDevice.deviceId, now),
                    ),
                ),
        ),
    );
}

/** Ends the access of the matching browser devices whose access has not ended yet; ended access stays ended. */
function endDevices(database: IdentityDatabase, devices: SQL | undefined, now: number) {
    return database
        .update(browserDevice)
        .set({ endedAt: now })
        .where(and(devices, isNull(browserDevice.endedAt)));
}

const callerOwnerCredential = alias(ownerCredential, "caller_owner_credential");

/**
 * The credential `tokenHash` is the computer's own and still holds access. Operations that end other access apply it in
 * their writes, so a credential ended while the request waited cannot still end anything.
 */
function ownerCredentialHolds(database: IdentityDatabase, tokenHash: string) {
    return exists(
        database
            .select({ id: callerOwnerCredential.id })
            .from(callerOwnerCredential)
            .where(and(eq(callerOwnerCredential.tokenHash, tokenHash), ownerAccessHeld(callerOwnerCredential))),
    );
}

/** The credential `tokenHash` still holds access: the computer's own, or a browser's whose device holds. */
function credentialHolds(database: IdentityDatabase, tokenHash: string, now: number) {
    const browserHolds = exists(
        database
            .select({ id: browserCredential.id })
            .from(browserCredential)
            .where(and(eq(browserCredential.tokenHash, tokenHash), browserCredentialInForce(database, now))),
    );
    return sql`(${ownerCredentialHolds(database, tokenHash)} OR ${browserHolds})`;
}

/** How a browser joining through a link describes itself, and roughly where Cloudflare saw it connect from. */
export interface JoiningDevice {
    readonly label: string | null;
    readonly location: ClientLocation | null;
}

export interface IdentityTransfer extends SharedLinkTerms {
    readonly code: string;
}

/**
 * A credential of the computer's owner as it stands now. The computer's own credential holds its own access or was
 * revoked; a browser credential holds its device's access until its device's term, unless a newer
 * credential of the device replaced it or the device's access ended.
 */
export type StoredCredential = { readonly credentialId: string } & (
    | { readonly kind: "local"; readonly held: boolean }
    | {
          readonly kind: "browser";
          readonly transferId: string;
          readonly deviceId: string;
          readonly replaced: boolean;
          /** The device's term while it holds access; null once its access ended. */
          readonly accessHeldUntil: number | null;
      }
);

/** The bound Durable Object is the Computer scope; credentials and devices never establish a separate user. */
export class IdentityStorage {
    readonly #database: DurableObjectDatabase;
    readonly #computerId: string;

    constructor(database: DurableObjectDatabase, computerId: string) {
        this.#database = database;
        this.#computerId = computerId;
    }

    readonly createComputer = async (
        computerId: string,
        signal: AbortSignal,
        token: string,
    ): Promise<AnonymousIdentity | null> => {
        signal.throwIfAborted();
        if (computerId !== this.#computerId) {
            return null;
        }
        const credentialId = `cred_${crypto.randomUUID()}`;
        const tokenHash = await digest(token);
        signal.throwIfAborted();
        const database = this.#database.orm;
        await database
            .insert(ownerCredential)
            .values({ id: credentialId, tokenHash })
            .onConflictDoNothing({ target: ownerCredential.tokenHash })
            .run();
        signal.throwIfAborted();
        // A retry reuses the committed row, including its revocation; it never resets or replaces it.
        const credential = await database
            .select({ id: ownerCredential.id })
            .from(ownerCredential)
            .where(and(eq(ownerCredential.tokenHash, tokenHash), ownerAccessHeld()))
            .get();
        signal.throwIfAborted();
        return credential === undefined ? null : { computerToken: token, computerId };
    };

    /**
     * The owner's credential this token authenticates as, as it stands at `now`; null for any other token. The computer's
     * own credential is read first, so the credential its holder chose as the successor is that one.
     */
    readonly findCredential = async (
        token: string,
        now: number,
        signal: AbortSignal,
    ): Promise<StoredCredential | null> => {
        signal.throwIfAborted();
        const tokenHash = await digest(token);
        const database = this.#database.orm;
        const owner = await database
            .select({
                credentialId: ownerCredential.id,
                held: sql<number>`CASE WHEN ${ownerAccessHeld()} THEN 1 ELSE 0 END`.as("held"),
            })
            .from(ownerCredential)
            .where(eq(ownerCredential.tokenHash, tokenHash))
            .get();
        signal.throwIfAborted();
        if (owner !== undefined) {
            return { credentialId: owner.credentialId, kind: "local", held: owner.held === 1 };
        }
        const browser = await database
            .select({
                credentialId: browserCredential.id,
                transferId: browserCredential.transferId,
                // Durable Object rows are keyed by column name, so each joined column needs a name of its own.
                deviceId: sql<string>`${browserCredential.deviceId}`.as("credential_device_id"),
                replacedAt: browserCredential.replacedAt,
                accessHeldUntil: deviceAccessHeldUntil(database, browserDevice, now).as("access_held_until"),
            })
            .from(browserCredential)
            .innerJoin(browserDevice, eq(browserDevice.id, browserCredential.deviceId))
            .where(eq(browserCredential.tokenHash, tokenHash))
            .get();
        signal.throwIfAborted();
        if (browser === undefined) {
            return null;
        }
        return {
            kind: "browser",
            credentialId: browser.credentialId,
            transferId: browser.transferId,
            deviceId: browser.deviceId,
            replaced: browser.replacedAt !== null,
            accessHeldUntil: browser.accessHeldUntil,
        };
    };

    /**
     * Whether the access a Session credential carries holds at `now`: its browser device's, or the computer's own
     * credential's. Only the computer owner's access holds.
     */
    readonly holdsAccess = async (holder: SessionAccessHolder, now: number, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const database = this.#database.orm;
        const found =
            holder.kind === "device"
                ? await database
                      .select({ id: browserDevice.id })
                      .from(browserDevice)
                      .where(
                          and(
                              eq(browserDevice.id, holder.deviceId),
                              sql`${deviceAccessHeldUntil(database, browserDevice, now)} IS NOT NULL`,
                          ),
                      )
                      .get()
                : await database
                      .select({ id: ownerCredential.id })
                      .from(ownerCredential)
                      .where(and(eq(ownerCredential.id, holder.credentialId), ownerAccessHeld()))
                      .get();
        signal.throwIfAborted();
        return found !== undefined;
    };

    /**
     * This Computer's browser devices that hold access at `now`: each described by its first joining, with its term and who
     * shared the link it joined through.
     */
    readonly linkedDevices = async (now: number, signal: AbortSignal) => {
        signal.throwIfAborted();
        const database = this.#database.orm;
        const sharedByOwner = alias(linkSharedByOwner, "joined_through_shared_by_owner");
        const sharedByDevice = alias(linkSharedByDevice, "joined_through_shared_by_device");
        const sharerDevice = alias(browserDevice, "sharer_device");
        const accessHeldUntil = deviceAccessHeldUntil(database, browserDevice, now);
        const rows = await database
            .select({
                // Durable Object rows are keyed by column name, so each joined column needs a name of its own.
                deviceId: sql<string>`${browserDevice.id}`.as("device_id"),
                joinedAt: browserDevice.joinedAt,
                label: browserDevice.label,
                joinedCity: browserDevice.joinedCity,
                joinedCountry: browserDevice.joinedCountry,
                accessHeldUntil: accessHeldUntil.as("access_held_until"),
                sharerKind: sql<
                    Credential["kind"] | null
                >`CASE WHEN ${sharedByOwner.linkId} IS NOT NULL THEN 'local' WHEN ${sharedByDevice.linkId} IS NOT NULL THEN 'browser' END`.as(
                    "sharer_kind",
                ),
                sharerLabel: sql<string | null>`${sharerDevice.label}`.as("sharer_label"),
            })
            .from(browserDevice)
            .leftJoin(sharedByOwner, eq(sharedByOwner.linkId, browserDevice.joinedThroughTransferId))
            .leftJoin(sharedByDevice, eq(sharedByDevice.linkId, browserDevice.joinedThroughTransferId))
            .leftJoin(sharerDevice, eq(sharerDevice.id, sharedByDevice.deviceId))
            // Ended access never resumes; reading only the devices that hold access keeps the list short.
            .where(sql`${accessHeldUntil} IS NOT NULL`)
            .all();
        signal.throwIfAborted();
        return rows;
    };

    /** Whether the computer's own credential `tokenHash` still holds access; once it does not, it never does again. */
    readonly #ownerHolds = async (database: IdentityDatabase, tokenHash: string): Promise<boolean> =>
        (await database
            .select({ id: ownerCredential.id })
            .from(ownerCredential)
            .where(and(eq(ownerCredential.tokenHash, tokenHash), ownerAccessHeld()))
            .get()) !== undefined;

    /** Whether the credential `tokenHash` still holds access: the computer's own, or a browser's whose device holds. */
    readonly #credentialHolds = async (database: IdentityDatabase, tokenHash: string, now: number): Promise<boolean> =>
        (await this.#ownerHolds(database, tokenHash)) ||
        (await database
            .select({ id: browserCredential.id })
            .from(browserCredential)
            .where(and(eq(browserCredential.tokenHash, tokenHash), browserCredentialInForce(database, now)))
            .get()) !== undefined;

    /**
     * Revokes every local credential except the caller's, ends every browser device's access, and cancels
     * the links no device has used yet. Only the computer's own credential, which belongs to no device, may do this,
     * and only while it holds access: false when it did not, with nothing changed.
     */
    readonly revokeOtherAccess = async (token: string, now: number, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const database = this.#database.orm;
        const tokenHash = await digest(token);
        const callerHolds = ownerCredentialHolds(database, tokenHash);
        this.#database.batch(
            [
                cancelUnusedLinks(database, now, callerHolds),
                database
                    .update(ownerCredential)
                    .set({ revokedAt: now })
                    .where(and(ne(ownerCredential.tokenHash, tokenHash), ownerAccessHeld(), callerHolds)),
                endDevices(database, callerHolds, now),
            ],
            signal,
        );
        signal.throwIfAborted();
        return await this.#ownerHolds(database, tokenHash);
    };

    /**
     * Revokes every local credential, the caller's included, and ends every browser device's access, in one
     * transaction that issues `successor` as the only local credential. Every link was shared by access this ends, so
     * none adds a device afterwards. Only
     * the computer's own credential may do this, so a copy of it stops working too. Repeating it with the successor as
     * the caller, after a lost reply, repeats the revocation and keeps the successor. False when the caller no longer
     * holds access, and then nothing changed.
     */
    readonly revokeAllAccess = async (
        token: string,
        successor: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const database = this.#database.orm;
        const tokenHash = await digest(token);
        const successorHash = await digest(successor);
        const localCredential = (hash: string) => and(eq(ownerCredential.tokenHash, hash), ownerAccessHeld());
        const successorInForce = exists(
            database
                .select({ id: successorCredential.id })
                .from(successorCredential)
                .where(and(eq(successorCredential.tokenHash, successorHash), ownerAccessHeld(successorCredential))),
        );
        this.#database.batch(
            [
                database
                    .insert(ownerCredential)
                    .select(
                        database
                            .select({
                                id: sql<string>`${`cred_${crypto.randomUUID()}`}`.as("id"),
                                tokenHash: sql<string>`${successorHash}`.as("token_hash"),
                                revokedAt: sql<null>`null`.as("revoked_at"),
                            })
                            .from(ownerCredential)
                            .where(localCredential(tokenHash)),
                    )
                    .onConflictDoNothing({ target: ownerCredential.tokenHash }),
                // Nothing else changes unless the successor holds access: a caller revoked meanwhile revokes nothing.
                database
                    .update(ownerCredential)
                    .set({ revokedAt: now })
                    .where(and(ne(ownerCredential.tokenHash, successorHash), ownerAccessHeld(), successorInForce)),
                endDevices(database, successorInForce, now),
            ],
            signal,
        );
        const rotated = await database
            .select({ id: ownerCredential.id })
            .from(ownerCredential)
            .where(localCredential(successorHash))
            .get();
        signal.throwIfAborted();
        return rotated !== undefined;
    };

    /**
     * Ends the access of every browser device except the one kept, and cancels the links no device has used yet. The
     * computer's own credential belongs to no device, so it stays. Done only while the caller's credential `token`
     * holds access: false when it did not, with nothing changed.
     */
    readonly endOtherBrowserAccess = async (
        token: string,
        keptDeviceId: string | null,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const database = this.#database.orm;
        const tokenHash = await digest(token);
        const callerHolds = credentialHolds(database, tokenHash, now);
        this.#database.batch(
            [
                cancelUnusedLinks(database, now, callerHolds),
                endDevices(
                    database,
                    and(keptDeviceId === null ? undefined : ne(browserDevice.id, keptDeviceId), callerHolds),
                    now,
                ),
            ],
            signal,
        );
        signal.throwIfAborted();
        return await this.#credentialHolds(database, tokenHash, now);
    };

    /** Claims an unopened predecessor and issues its successor atomically; retries read the committed issuance. */
    readonly createTransfer = async (
        parentToken: string,
        now: number,
        terms: SharedLinkTerms,
        replaces: string | null,
        operation: { readonly code: string; readonly requestHash: string },
        signal: AbortSignal,
    ): Promise<
        | {
              readonly kind: "issued";
              readonly createdAt: number;
              readonly expiresAt: number;
              readonly accessExpiresAt: number;
          }
        | { readonly kind: "conflict" }
    > => {
        signal.throwIfAborted();
        // Check the issuing credential in the write itself so ending its access cannot race issuance.
        const database = this.#database.orm;
        const parentTokenHash = await digest(parentToken);
        const codeHash = await digest(operation.code);
        const replacesHash = replaces === null ? null : await digest(replaces);
        const ownerIssuer = and(eq(ownerCredential.tokenHash, parentTokenHash), ownerAccessHeld());
        const browserIssuer = and(
            eq(browserCredential.tokenHash, parentTokenHash),
            browserCredentialInForce(database, now),
        );
        // The link the issuer's access shared: by the computer's own credential the token names, or by the device the
        // token's browser credential belongs to, so a renewed credential still stands for the device that shared it.
        const sharedByIssuer = (linkId: SQLiteColumn) =>
            or(
                exists(
                    database
                        .select({ id: linkSharedByOwner.linkId })
                        .from(linkSharedByOwner)
                        .where(
                            and(
                                eq(linkSharedByOwner.linkId, linkId),
                                inArray(
                                    linkSharedByOwner.ownerCredentialId,
                                    database
                                        .select({ id: ownerCredential.id })
                                        .from(ownerCredential)
                                        .where(ownerIssuer),
                                ),
                            ),
                        ),
                ),
                exists(
                    database
                        .select({ id: linkSharedByDevice.linkId })
                        .from(linkSharedByDevice)
                        .where(
                            and(
                                eq(linkSharedByDevice.linkId, linkId),
                                inArray(
                                    linkSharedByDevice.deviceId,
                                    database
                                        .select({ id: browserCredential.deviceId })
                                        .from(browserCredential)
                                        .where(browserIssuer),
                                ),
                            ),
                        ),
                ),
            );
        // The unused link the issuer shared before and this one replaces; replacing it is recorded on this link alone.
        const predecessor = and(
            eq(predecessorLink.codeHash, replacesHash ?? ""),
            linkInForce(database, now, predecessorLink),
            unusedLink(database, predecessorLink.id),
            sharedByIssuer(predecessorLink.id),
        );
        const predecessorId = database.select({ id: predecessorLink.id }).from(predecessorLink).where(predecessor);
        const predecessorOpen = replacesHash === null ? undefined : exists(predecessorId);
        // The link's columns in table order.
        const linkColumns = {
            id: sql<string>`${`transfer_${crypto.randomUUID()}`}`.as("id"),
            codeHash: sql<string>`${codeHash}`.as("code_hash"),
            requestHash: sql<string>`${operation.requestHash}`.as("request_hash"),
            expiresAt: sql<number>`${terms.expiresAt}`.as("expires_at"),
            accessExpiresAt: sql<number>`${terms.accessExpiresAt}`.as("access_expires_at"),
            createdAt: sql<number>`${now}`.as("created_at"),
            replacesTransferId: (replacesHash === null ? sql<null>`null` : sql<string>`(${predecessorId})`).as(
                "replaces_transfer_id",
            ),
            cancelledAt: sql<null>`null`.as("cancelled_at"),
        };
        // The token names one credential, of one kind, so at most one of these issues the link.
        const issueByOwner = database
            .insert(continueLink)
            .select(database.select(linkColumns).from(ownerCredential).where(and(ownerIssuer, predecessorOpen)))
            .onConflictDoNothing({ target: continueLink.codeHash });
        const issueByBrowser = database
            .insert(continueLink)
            .select(database.select(linkColumns).from(browserCredential).where(and(browserIssuer, predecessorOpen)))
            .onConflictDoNothing({ target: continueLink.codeHash });
        // The access that shared the link is recorded in the same transaction; a link that already existed has its.
        const unshared = and(
            eq(continueLink.codeHash, codeHash),
            notExists(
                database
                    .select({ id: linkSharedByOwner.linkId })
                    .from(linkSharedByOwner)
                    .where(eq(linkSharedByOwner.linkId, continueLink.id)),
            ),
            notExists(
                database
                    .select({ id: linkSharedByDevice.linkId })
                    .from(linkSharedByDevice)
                    .where(eq(linkSharedByDevice.linkId, continueLink.id)),
            ),
        );
        const recordOwnerSharer = database
            .insert(linkSharedByOwner)
            .select(
                database
                    .select({ linkId: continueLink.id, ownerCredentialId: ownerCredential.id })
                    .from(continueLink)
                    .innerJoin(ownerCredential, ownerIssuer)
                    .where(unshared),
            );
        const recordDeviceSharer = database
            .insert(linkSharedByDevice)
            .select(
                database
                    .select({ linkId: continueLink.id, deviceId: browserCredential.deviceId })
                    .from(continueLink)
                    .innerJoin(browserCredential, browserIssuer)
                    .where(unshared),
            );
        signal.throwIfAborted();
        this.#database.batch([issueByOwner, issueByBrowser, recordOwnerSharer, recordDeviceSharer], signal);
        const issued = await database
            .select({
                createdAt: continueLink.createdAt,
                expiresAt: continueLink.expiresAt,
                accessExpiresAt: continueLink.accessExpiresAt,
            })
            .from(continueLink)
            .where(
                and(
                    eq(continueLink.codeHash, codeHash),
                    eq(continueLink.requestHash, operation.requestHash),
                    linkInForce(database, now),
                    sharedByIssuer(continueLink.id),
                ),
            )
            .get();
        signal.throwIfAborted();
        return issued === undefined ? { kind: "conflict" } : { kind: "issued", ...issued };
    };

    /**
     * Opens a link in a browser. `replaces` is the credential the browser already holds for this Computer: a browser
     * keeps one credential, so the new one replaces it at once and belongs to the same device while that device still
     * holds access; the device keeps the later of its term and this link's. A browser holding none, or whose device's
     * access ended, becomes a new device, described by this joining.
     *
     * `token` is the credential this redemption issues. A link issues one credential, so repeating the redemption that
     * used it, with the same token, returns that credential while it still holds access instead of refusing the browser
     * whose first reply was lost; it never issues another.
     */
    readonly redeemTransfer = async (
        code: string,
        replaces: string | null,
        joining: JoiningDevice,
        token: string,
        now: number,
        signal: AbortSignal,
    ): Promise<AnonymousIdentity | null> => {
        const parsed = readTransferCredential(code);
        if (parsed?.kind !== "morty_transfer_v1" || parsed.computerId !== this.#computerId) {
            return null;
        }
        signal.throwIfAborted();
        const database = this.#database.orm;
        const codeHash = await digest(code);
        const credentialId = `cred_${crypto.randomUUID()}`;
        const newDeviceId = `device_${crypto.randomUUID()}`;
        // A link adds one device: only while no credential was issued through it.
        const open = and(
            eq(continueLink.codeHash, codeHash),
            linkInForce(database, now),
            gt(continueLink.accessExpiresAt, now),
            unusedLink(database),
            // A link adds no device once the access that shared it ended; checking it in the issuing write means ending
            // that access needs no separate write to void the link. Renewal replaces a credential without ending its
            // access, so invitations survive it.
            linkSharerHolds(database, continueLink.id, now),
        );
        const replacedHash = replaces === null ? null : await digest(replaces);
        const tokenHash = await digest(token);
        // This Durable Object holds only this Computer's credentials.
        const replaced = eq(browserCredential.tokenHash, replacedHash ?? "");
        // The replaced credential may already be replaced by a concurrent or retried redemption in the same browser;
        // the device it belongs to is kept while that device holds access. The read and the writes below run with no
        // other request in between: the Computer's Durable Object runs its SQL synchronously.
        const kept =
            replacedHash === null
                ? undefined
                : await database
                      .select({ id: browserDevice.id })
                      .from(browserDevice)
                      .innerJoin(browserCredential, eq(browserCredential.deviceId, browserDevice.id))
                      .where(and(replaced, sql`${deviceAccessHeldUntil(database, browserDevice, now)} IS NOT NULL`))
                      .get();
        const deviceId = kept?.id ?? newDeviceId;
        const issued = database
            .select({ id: browserCredential.id })
            .from(browserCredential)
            .where(eq(browserCredential.id, credentialId));
        const issue = database.insert(browserCredential).select(
            database
                .select({
                    id: sql<string>`${credentialId}`.as("id"),
                    tokenHash: sql<string>`${tokenHash}`.as("token_hash"),
                    deviceId: sql<string>`${deviceId}`.as("device_id"),
                    transferId: continueLink.id,
                    replacedAt: sql<null>`null`.as("replaced_at"),
                })
                .from(continueLink)
                .where(open),
        );
        const describe = database.insert(browserDevice).select(
            database
                .select({
                    id: sql<string>`${newDeviceId}`.as("id"),
                    joinedAt: sql<number>`${now}`.as("joined_at"),
                    label: sql<string | null>`${joining.label}`.as("label"),
                    joinedCity: sql<string | null>`${joining.location?.city ?? null}`.as("joined_city"),
                    joinedCountry: sql<string | null>`${joining.location?.country ?? null}`.as("joined_country"),
                    joinedThroughTransferId: browserCredential.transferId,
                    endedAt: sql<null>`null`.as("ended_at"),
                })
                .from(browserCredential)
                .where(and(eq(browserCredential.id, credentialId), eq(browserCredential.deviceId, newDeviceId))),
        );
        this.#database.batch(
            [
                issue,
                describe,
                // Only a credential of the device the new one joins is replaced; one whose device's access ended stays as
                // it was, ended with its device.
                database
                    .update(browserCredential)
                    .set({ replacedAt: now })
                    .where(
                        and(
                            replaced,
                            eq(browserCredential.deviceId, deviceId),
                            isNull(browserCredential.replacedAt),
                            exists(issued),
                        ),
                    ),
            ],
            signal,
        );
        signal.throwIfAborted();
        // Issued just now, or by an earlier attempt of this redemption whose reply was lost, while it still grants its
        // device's access.
        const issuedThroughLink = await database
            .select({ id: browserCredential.id })
            .from(browserCredential)
            .innerJoin(continueLink, eq(continueLink.id, browserCredential.transferId))
            .where(
                and(
                    eq(browserCredential.tokenHash, tokenHash),
                    eq(continueLink.codeHash, codeHash),
                    browserCredentialInForce(database, now),
                ),
            )
            .get();
        signal.throwIfAborted();
        return issuedThroughLink === undefined ? null : { computerToken: token, computerId: parsed.computerId };
    };

    readonly revokeCredential = async (
        credential: Exclude<Credential, { readonly kind: "browser" }>,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const revoked = await this.#database.orm
            .update(ownerCredential)
            .set({ revokedAt: now })
            .where(and(eq(ownerCredential.id, credential.credentialId), ownerAccessHeld()))
            .returning({ id: ownerCredential.id })
            .get();
        signal.throwIfAborted();
        return revoked !== undefined;
    };

    /**
     * Ends the access of one of this Computer's browser devices, and with it every credential of that device, including one
     * a retried or concurrent redemption issued; its unused invitations add no device once it ended. Done only while the
     * caller's credential `token` holds access, checked in the write itself: `callerEnded`, with nothing changed, when it
     * did not. `unknown` when this Computer has no such device; a device whose access already ended stays ended, so
     * repeating is harmless.
     */
    readonly endDeviceAccess = async (
        token: string,
        deviceId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<{ readonly kind: "ended" } | { readonly kind: "unknown" } | { readonly kind: "callerEnded" }> => {
        signal.throwIfAborted();
        const database = this.#database.orm;
        const tokenHash = await digest(token);
        const device = eq(browserDevice.id, deviceId);
        const { meta } = this.#database.run(
            endDevices(database, and(device, credentialHolds(database, tokenHash, now)), now),
            signal,
        );
        if (meta.changes > 0) {
            return { kind: "ended" };
        }
        // Nothing changed: the caller no longer holds access, or the device is unknown or already ended.
        if (!(await this.#credentialHolds(database, tokenHash, now))) {
            signal.throwIfAborted();
            return { kind: "callerEnded" };
        }
        const found = await database.select({ id: browserDevice.id }).from(browserDevice).where(device).get();
        signal.throwIfAborted();
        return found === undefined ? { kind: "unknown" } : { kind: "ended" };
    };
}
