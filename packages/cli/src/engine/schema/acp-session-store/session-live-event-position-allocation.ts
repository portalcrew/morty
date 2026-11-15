import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionLiveEventPositionAllocation = sqliteTable(
    "session_live_event_position_allocation",
    {
        allocatedPosition: integer("allocated_position").notNull().default(10_000),
        harness: text("harness").notNull(),
        sessionId: text("session_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.harness, table.sessionId] })],
);
