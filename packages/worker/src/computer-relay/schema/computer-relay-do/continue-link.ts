import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
 * The access that shared a link: the computer's own credential (`holderId` is its id) or a browser device. A link adds
 * no device once its sharer's access ended; opening another link replaces a device's credential and never ends its
 * access, so the link survives it.
 */
export const linkSharer = sqliteTable(
    "link_sharer",
    {
        linkId: text("link_id").primaryKey().notNull(),
        holderKind: text("holder_kind", { enum: ["owner", "device"] }).notNull(),
        holderId: text("holder_id").notNull(),
    },
    (table) => [check("link_sharer_holder_kind", sql`${table.holderKind} IN ('owner', 'device')`)],
);
