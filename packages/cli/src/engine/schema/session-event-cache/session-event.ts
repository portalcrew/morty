import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionEvent = sqliteTable(
    "session_event_cache",
    {
        eventId: text("event_id").notNull(),
        eventJson: text("event_json").notNull(),
        generationId: text("generation_id").notNull(),
        harness: text("harness").notNull(),
        ordinal: integer("position").notNull(),
        sessionId: text("session_id").notNull(),
    },
    (table) => [
        // Deterministic native-history generations replay identical event IDs
        // into different conversations, so rows are scoped per Session.
        primaryKey({ columns: [table.harness, table.sessionId, table.eventId] }),
        index("session_event_cache_generation_session_position_index").on(
            table.generationId,
            table.harness,
            table.sessionId,
            table.ordinal,
        ),
    ],
);
