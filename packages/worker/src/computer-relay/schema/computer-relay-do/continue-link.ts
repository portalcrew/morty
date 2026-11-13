import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A link the owner shared to add one browser device. It stores what was shared and the owner's own decisions about it;
 * whether it can still add a device follows from those, from its terms, from whether a device used it, and from
 * whether the access that shared it still holds. That access is recorded in `link_shared_by_device` or
 * `link_shared_by_owner`: every link has exactly one of them.
 */
export const continueLink = sqliteTable(
    "identity_transfer",
    {
        id: text("id").primaryKey().notNull(),
        codeHash: text("code_hash").notNull().unique(),
        /** The original issuance intent, so a retry cannot change an operation's terms or predecessor. */
        requestHash: text("request_hash").notNull(),
        /** Until when the link can add a device. */
        expiresAt: integer("expires_at").notNull(),
        /** Until when the device the link adds keeps access. A link adds one device: the credential it issued. */
        accessExpiresAt: integer("access_expires_at").notNull(),
        createdAt: integer("created_at").notNull(),
        /** The unused link this one replaced when it was shared; a link is replaced at most once. */
        replacesTransferId: text("replaces_transfer_id").unique(),
        /** When the owner cancelled the link's invitation, if they did. */
        cancelledAt: integer("cancelled_at"),
    },
    (table) => [index("identity_transfer_expiry_idx").on(table.expiresAt)],
);

/**
 * A link shared by a browser device's access. The link adds no device once that device's access ended; opening another
 * link replaces the device's credential and never ends its access, so the link survives it.
 */
export const linkSharedByDevice = sqliteTable("link_shared_by_device", {
    linkId: text("link_id").primaryKey().notNull(),
    deviceId: text("device_id").notNull(),
});

/** A link shared by the computer's own credential. The link adds no device once that credential was revoked. */
export const linkSharedByOwner = sqliteTable("link_shared_by_owner", {
    linkId: text("link_id").primaryKey().notNull(),
    ownerCredentialId: text("owner_credential_id").notNull(),
});
