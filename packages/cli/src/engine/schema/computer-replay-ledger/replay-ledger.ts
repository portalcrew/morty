import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const replayClaim = sqliteTable(
    "replay_claim",
    {
        fingerprint: text("fingerprint").primaryKey(),
        expiresAt: integer("expires_at").notNull(),
    },
    (table) => [index("replay_claim_expiry_idx").on(table.expiresAt)],
);

/**
 * The latest time the Computer admitted a packet at. A clock set back never moves it back, so a packet whose claim
 * expired cannot be admitted again. The table holds at most one row.
 */
export const replayClock = sqliteTable(
    "replay_clock",
    {
        id: integer("id").primaryKey(),
        latestAt: integer("latest_at").notNull(),
    },
    (table) => [check("replay_clock_single_row", sql`${table.id} = 0`)],
);
