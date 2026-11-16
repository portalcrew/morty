import type { SessionAccessHolder } from "@portalcrew/morty-client/protocol";
import { and, eq, exists, inArray, isNull, max, or, type SQL, sql } from "drizzle-orm";
import { alias, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import {
    browserCredential,
    browserDevice,
    continueLink,
    linkSharer,
    ownerCredential,
} from "../../../schema/computer-relay-do/index.ts";

type AccessDatabase = DurableObjectDatabase["orm"];

export type OwnerHolder = { readonly kind: "owner"; readonly credentialId: string };
export type DeviceHolder = { readonly kind: "device"; readonly deviceId: string };
export type AccessHolder = OwnerHolder | DeviceHolder;

export type OwnerStanding = { readonly kind: "ended" } | { readonly kind: "held" };
export type DeviceStanding = { readonly kind: "ended" } | { readonly kind: "held"; readonly until: number };

export function accessHolderOfGrant(holder: SessionAccessHolder): AccessHolder {
    switch (holder.kind) {
        case "device":
            return { kind: "device", deviceId: holder.deviceId };
        case "credential":
            return { kind: "owner", credentialId: holder.credentialId };
    }
}

/**
 * The one rule for who still holds access. The computer's own credential holds until it is revoked. A browser device
 * holds until the end of its term unless it was ended first, and ended access never resumes; revoking a link only
 * stops it from adding a device. Everything that reads or guards a write on access asks this module, in SQL here and
 * as a value read back by the standings below.
 */
export function ownerHeld(owner: { readonly revokedAt: SQLiteColumn } = ownerCredential) {
    return isNull(owner.revokedAt);
}

export function ownerStanding(held: boolean): OwnerStanding {
    return held ? { kind: "held" } : { kind: "ended" };
}

const openedCredential = alias(browserCredential, "opened_credential");
const openedLink = alias(continueLink, "opened_link");
const heldDevice = alias(browserDevice, "held_device");
const heldOwner = alias(ownerCredential, "held_owner");
const callerOwnerCredential = alias(ownerCredential, "caller_owner_credential");
const callerBrowserCredential = alias(browserCredential, "caller_browser_credential");

/** A device's term is the latest among the links it opened, so opening another link never shortens it. */
function deviceTerm(database: AccessDatabase, deviceId: SQLiteColumn) {
    return sql<number | null>`(${database
        .select({ term: max(openedLink.accessExpiresAt) })
        .from(openedCredential)
        .innerJoin(openedLink, eq(openedLink.id, openedCredential.transferId))
        .where(eq(openedCredential.deviceId, deviceId))})`;
}

/** The end of the device's term while it holds access, null once it does not. */
export function deviceHeldUntil(
    database: AccessDatabase,
    device: { readonly id: SQLiteColumn; readonly endedAt: SQLiteColumn },
    now: number,
) {
    const term = deviceTerm(database, device.id);
    return sql<number | null>`(CASE WHEN ${device.endedAt} IS NULL AND ${term} > ${now} THEN ${term} END)`;
}

export function deviceStanding(heldUntil: number | null): DeviceStanding {
    return heldUntil === null ? { kind: "ended" } : { kind: "held", until: heldUntil };
}

export function deviceHolds(database: AccessDatabase, deviceId: SQLiteColumn | string, now: number) {
    return exists(
        database
            .select({ id: heldDevice.id })
            .from(heldDevice)
            .where(and(eq(heldDevice.id, deviceId), sql`${deviceHeldUntil(database, heldDevice, now)} IS NOT NULL`)),
    );
}

function ownerHolds(database: AccessDatabase, credentialId: SQLiteColumn | string) {
    return exists(
        database
            .select({ id: heldOwner.id })
            .from(heldOwner)
            .where(and(eq(heldOwner.id, credentialId), ownerHeld(heldOwner))),
    );
}

export function holderHolds(database: AccessDatabase, holder: AccessHolder, now: number) {
    switch (holder.kind) {
        case "owner":
            return ownerHolds(database, holder.credentialId);
        case "device":
            return deviceHolds(database, holder.deviceId, now);
    }
}

/** The token is the computer's own credential and it holds access. */
export function ownerTokenHeld(
    tokenHash: string,
    owner: { readonly tokenHash: SQLiteColumn; readonly revokedAt: SQLiteColumn } = ownerCredential,
) {
    return and(eq(owner.tokenHash, tokenHash), ownerHeld(owner));
}

/** The token is a browser credential no newer one replaced, and its device holds access. */
export function browserTokenHeld(
    database: AccessDatabase,
    tokenHash: string,
    now: number,
    credential: {
        readonly tokenHash: SQLiteColumn;
        readonly replacedAt: SQLiteColumn;
        readonly deviceId: SQLiteColumn;
    } = browserCredential,
) {
    return and(
        eq(credential.tokenHash, tokenHash),
        isNull(credential.replacedAt),
        deviceHolds(database, credential.deviceId, now),
    );
}

export function ownerCredentialHolds(database: AccessDatabase, tokenHash: string) {
    return exists(
        database
            .select({ id: callerOwnerCredential.id })
            .from(callerOwnerCredential)
            .where(ownerTokenHeld(tokenHash, callerOwnerCredential)),
    );
}

export function credentialHolds(database: AccessDatabase, tokenHash: string, now: number) {
    return or(
        ownerCredentialHolds(database, tokenHash),
        exists(
            database
                .select({ id: callerBrowserCredential.id })
                .from(callerBrowserCredential)
                .where(browserTokenHeld(database, tokenHash, now, callerBrowserCredential)),
        ),
    );
}

/** The link's sharer still holds access, so ending that access needs no write to void its links. */
export function linkSharerHolds(database: AccessDatabase, linkId: SQLiteColumn, now: number) {
    return exists(
        database
            .select({ id: linkSharer.linkId })
            .from(linkSharer)
            .where(
                and(
                    eq(linkSharer.linkId, linkId),
                    or(
                        and(eq(linkSharer.holderKind, "owner"), ownerHolds(database, linkSharer.holderId)),
                        and(eq(linkSharer.holderKind, "device"), deviceHolds(database, linkSharer.holderId, now)),
                    ),
                ),
            ),
    );
}

/** The link was shared by the holder of this token, whichever of its credentials the token is. */
export function linkSharedByToken(database: AccessDatabase, linkId: SQLiteColumn, tokenHash: string, now: number) {
    return exists(
        database
            .select({ id: linkSharer.linkId })
            .from(linkSharer)
            .where(
                and(
                    eq(linkSharer.linkId, linkId),
                    or(
                        and(
                            eq(linkSharer.holderKind, "owner"),
                            inArray(
                                linkSharer.holderId,
                                database
                                    .select({ id: ownerCredential.id })
                                    .from(ownerCredential)
                                    .where(ownerTokenHeld(tokenHash)),
                            ),
                        ),
                        and(
                            eq(linkSharer.holderKind, "device"),
                            inArray(
                                linkSharer.holderId,
                                database
                                    .select({ id: browserCredential.deviceId })
                                    .from(browserCredential)
                                    .where(browserTokenHeld(database, tokenHash, now)),
                            ),
                        ),
                    ),
                ),
            ),
    );
}

/** Reads a predicate built by this module as it stands now. */
export function holds(database: AccessDatabase, predicate: SQL | undefined): boolean {
    const row = database.get<{ held: number }>(sql`SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS held`);
    return row.held === 1;
}
