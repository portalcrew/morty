import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A setup link's sealed contents: only the link holds the key, so the relay keeps ciphertext it cannot read. */
export const setupHandoff = sqliteTable(
    "setup_handoff",
    {
        lookupId: text("lookup_id").primaryKey().notNull(),
        sealed: text("sealed").notNull(),
        expiresAt: integer("expires_at").notNull(),
    },
    (table) => [index("setup_handoff_expiry_idx").on(table.expiresAt)],
);
