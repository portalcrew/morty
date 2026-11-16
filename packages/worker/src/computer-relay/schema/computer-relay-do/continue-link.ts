import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const continueLink = sqliteTable(
    "identity_transfer",
    {
        id: text("id").primaryKey().notNull(),
        codeHash: text("code_hash").notNull().unique(),
        /** The original issuance intent, so a retry cannot change an operation's terms or predecessor. */
        requestHash: text("request_hash").notNull(),
        expiresAt: integer("expires_at").notNull(),
        accessExpiresAt: integer("access_expires_at").notNull(),
        createdAt: integer("created_at").notNull(),
        replacesTransferId: text("replaces_transfer_id").unique(),
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

export const linkSharedByOwner = sqliteTable("link_shared_by_owner", {
    linkId: text("link_id").primaryKey().notNull(),
    ownerCredentialId: text("owner_credential_id").notNull(),
});
