import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A sealed link's contents: only the link holds the key, so the relay keeps ciphertext it cannot read. The table keeps
 * the name it had when setup links were the only sealed links.
 */
export const sealedHandoff = sqliteTable(
    "setup_handoff",
    {
        lookupId: text("lookup_id").primaryKey().notNull(),
        sealed: text("sealed").notNull(),
        expiresAt: integer("expires_at").notNull(),
    },
    (table) => [index("setup_handoff_expiry_idx").on(table.expiresAt)],
);
