import type { SessionAccessHolder } from "@portalcrew/morty-client/protocol";
import { and, eq, exists, gt, isNull, ne, notExists, type SQL, sql } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Credential, SharedLinkTerms } from "../../../../contracts/authentication/credential.ts";
import type { ClientLocation } from "../../../../contracts/client-location.ts";
import { readTransferCredential } from "../../../../contracts/transfer-credential.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import {
    browserCredential,
    browserDevice,
    continueLink,
    linkSharer,
    ownerCredential,
} from "../../../schema/computer-relay-do/index.ts";
import {
    accessHolderOfGrant,
    browserTokenHeld,
    credentialHolds,
    type DeviceHolder,
    type DeviceStanding,
    deviceHeldUntil,
    deviceHolds,
    deviceStanding,
    holderHolds,
    holds,
    linkSharedByToken,
    linkSharerHolds,
    type OwnerHolder,
    type OwnerStanding,
    ownerCredentialHolds,
    ownerHeld,
    ownerStanding,
    ownerTokenHeld,
} from "./access-holder.ts";
import { type AnonymousIdentity, digest } from "./identity-storage-common.ts";

type IdentityDatabase = DurableObjectDatabase["orm"];

function unusedLink(database: IdentityDatabase, linkId: SQLiteColumn = continueLink.id) {
    return notExists(
        database
            .select({ id: browserCredential.id })
            .from(browserCredential)
            .where(eq(browserCredential.transferId, linkId)),
    );
}
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
function cancelUnusedLinks(database: IdentityDatabase, now: number, by: SQL | undefined) {
    return database
        .update(continueLink)
        .set({ cancelledAt: now })
        .where(and(isNull(continueLink.cancelledAt), unusedLink(database), by));
}

function endDevices(database: IdentityDatabase, devices: SQL | undefined, now: number) {
    return database
        .update(browserDevice)
        .set({ endedAt: now })
        .where(and(devices, isNull(browserDevice.endedAt)));
}

export interface JoiningDevice {
    readonly label: string | null;
    readonly location: ClientLocation | null;
}

export interface IdentityTransfer extends SharedLinkTerms {
    readonly code: string;
}

/**
 * A credential of the computer's owner as it stands now, with the access holder it grants and that holder's standing.
 * A browser credential grants its device's access unless a newer credential of the device replaced it.
 */
export type StoredCredential = { readonly credentialId: string } & (
    | { readonly kind: "local"; readonly holder: OwnerHolder; readonly standing: OwnerStanding }
    | {
          readonly kind: "browser";
          readonly transferId: string;
          readonly holder: DeviceHolder;
          readonly replaced: boolean;
          readonly standing: DeviceStanding;
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

    /**
     * Stores the owner's credential the token hash names and reports whether it holds access. Synchronous, so the
     * computer's creation commits it in the same transaction as the computer's existence. A retry reuses the committed
     * row, including its revocation; it never resets or replaces it.
     */
    readonly createOwner = (tokenHash: string): boolean => {
        const database = this.#database.orm;
        database
            .insert(ownerCredential)
            .values({ id: `cred_${crypto.randomUUID()}`, tokenHash })
            .onConflictDoNothing({ target: ownerCredential.tokenHash })
            .run();
        const credential = database
            .select({ id: ownerCredential.id })
            .from(ownerCredential)
            .where(ownerTokenHeld(tokenHash))
            .get();
        return credential !== undefined;
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
                held: sql<number>`CASE WHEN ${ownerHeld()} THEN 1 ELSE 0 END`.as("held"),
            })
            .from(ownerCredential)
            .where(eq(ownerCredential.tokenHash, tokenHash))
            .get();
        signal.throwIfAborted();
        if (owner !== undefined) {
            return {
                credentialId: owner.credentialId,
                kind: "local",
                holder: { kind: "owner", credentialId: owner.credentialId },
                standing: ownerStanding(owner.held === 1),
            };
        }
        const browser = await database
            .select({
                credentialId: browserCredential.id,
                transferId: browserCredential.transferId,
                // Durable Object rows are keyed by column name, so each joined column needs a name of its own.
                deviceId: sql<string>`${browserCredential.deviceId}`.as("credential_device_id"),
                replacedAt: browserCredential.replacedAt,
                accessHeldUntil: deviceHeldUntil(database, browserDevice, now).as("access_held_until"),
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
            holder: { kind: "device", deviceId: browser.deviceId },
            replaced: browser.replacedAt !== null,
            standing: deviceStanding(browser.accessHeldUntil),
        };
    };

    readonly holdsAccess = async (holder: SessionAccessHolder, now: number, signal: AbortSignal): Promise<boolean> => {
        signal.throwIfAborted();
        const database = this.#database.orm;
        return holds(database, holderHolds(database, accessHolderOfGrant(holder), now));
    };

    readonly linkedDevices = async (now: number, signal: AbortSignal) => {
        signal.throwIfAborted();
        const database = this.#database.orm;
        const sharerDevice = alias(browserDevice, "sharer_device");
        const accessHeldUntil = deviceHeldUntil(database, browserDevice, now);
        const rows = await database
            .select({
                // Durable Object rows are keyed by column name, so each joined column needs a name of its own.
                deviceId: sql<string>`${browserDevice.id}`.as("device_id"),
                joinedAt: browserDevice.joinedAt,
                label: browserDevice.label,
                joinedCity: browserDevice.joinedCity,
                joinedCountry: browserDevice.joinedCountry,
                accessHeldUntil: accessHeldUntil.as("access_held_until"),
                sharerKind: sql<"owner" | "device" | null>`${linkSharer.holderKind}`.as("sharer_kind"),
                sharerLabel: sql<string | null>`${sharerDevice.label}`.as("sharer_label"),
            })
            .from(browserDevice)
            .leftJoin(linkSharer, eq(linkSharer.linkId, browserDevice.joinedThroughTransferId))
            .leftJoin(sharerDevice, and(eq(linkSharer.holderKind, "device"), eq(sharerDevice.id, linkSharer.holderId)))
            // Ended access never resumes; reading only the devices that hold access keeps the list short.
            .where(sql`${accessHeldUntil} IS NOT NULL`)
            .all();
        signal.throwIfAborted();
        return rows;
    };

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
                    .where(and(ne(ownerCredential.tokenHash, tokenHash), ownerHeld(), callerHolds)),
                endDevices(database, callerHolds, now),
            ],
            signal,
        );
        signal.throwIfAborted();
        return holds(database, callerHolds);
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
        const successorInForce = ownerCredentialHolds(database, successorHash);
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
                            .where(ownerTokenHeld(tokenHash)),
                    )
                    .onConflictDoNothing({ target: ownerCredential.tokenHash }),
                // Nothing else changes unless the successor holds access: a caller revoked meanwhile revokes nothing.
                database
                    .update(ownerCredential)
                    .set({ revokedAt: now })
                    .where(and(ne(ownerCredential.tokenHash, successorHash), ownerHeld(), successorInForce)),
                endDevices(database, successorInForce, now),
            ],
            signal,
        );
        const rotated = await database
            .select({ id: ownerCredential.id })
            .from(ownerCredential)
            .where(ownerTokenHeld(successorHash))
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
        return holds(database, callerHolds);
    };

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
        const ownerIssuer = ownerTokenHeld(parentTokenHash);
        const browserIssuer = browserTokenHeld(database, parentTokenHash, now);
        const predecessor = and(
            eq(predecessorLink.codeHash, replacesHash ?? ""),
            linkInForce(database, now, predecessorLink),
            unusedLink(database, predecessorLink.id),
            linkSharedByToken(database, predecessorLink.id, parentTokenHash, now),
        );
        const predecessorId = database.select({ id: predecessorLink.id }).from(predecessorLink).where(predecessor);
        const predecessorOpen = replacesHash === null ? undefined : exists(predecessorId);
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
        // One row per link: whichever of these finds the issuer records it, and a link that has a sharer keeps it.
        const recordOwnerSharer = database
            .insert(linkSharer)
            .select(
                database
                    .select({
                        linkId: continueLink.id,
                        holderKind: sql<"owner">`'owner'`.as("holder_kind"),
                        holderId: ownerCredential.id,
                    })
                    .from(continueLink)
                    .innerJoin(ownerCredential, ownerIssuer)
                    .where(eq(continueLink.codeHash, codeHash)),
            )
            .onConflictDoNothing({ target: linkSharer.linkId });
        const recordDeviceSharer = database
            .insert(linkSharer)
            .select(
                database
                    .select({
                        linkId: continueLink.id,
                        holderKind: sql<"device">`'device'`.as("holder_kind"),
                        holderId: browserCredential.deviceId,
                    })
                    .from(continueLink)
                    .innerJoin(browserCredential, browserIssuer)
                    .where(eq(continueLink.codeHash, codeHash)),
            )
            .onConflictDoNothing({ target: linkSharer.linkId });
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
                    linkSharedByToken(database, continueLink.id, parentTokenHash, now),
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
        if (parsed === null || parsed.computerId !== this.#computerId) {
            return null;
        }
        signal.throwIfAborted();
        const database = this.#database.orm;
        const codeHash = await digest(code);
        const credentialId = `cred_${crypto.randomUUID()}`;
        const newDeviceId = `device_${crypto.randomUUID()}`;
        const open = and(
            eq(continueLink.codeHash, codeHash),
            linkInForce(database, now),
            gt(continueLink.accessExpiresAt, now),
            unusedLink(database),
            linkSharerHolds(database, continueLink.id, now),
        );
        const replacedHash = replaces === null ? null : await digest(replaces);
        const tokenHash = await digest(token);
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
                      .where(and(replaced, deviceHolds(database, browserDevice.id, now)))
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
        const issuedThroughLink = await database
            .select({ id: browserCredential.id })
            .from(browserCredential)
            .innerJoin(continueLink, eq(continueLink.id, browserCredential.transferId))
            .where(
                and(
                    eq(browserCredential.tokenHash, tokenHash),
                    eq(continueLink.codeHash, codeHash),
                    browserTokenHeld(database, tokenHash, now),
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
            .where(and(eq(ownerCredential.id, credential.credentialId), ownerHeld()))
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
        if (!holds(database, credentialHolds(database, tokenHash, now))) {
            signal.throwIfAborted();
            return { kind: "callerEnded" };
        }
        const found = await database.select({ id: browserDevice.id }).from(browserDevice).where(device).get();
        signal.throwIfAborted();
        return found === undefined ? { kind: "unknown" } : { kind: "ended" };
    };
}
