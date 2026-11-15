import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Every command a Session admitted and what became of it. A row is the command's only authority: its identity, its
 * admission order and its fate change together, and only a command that settled before it started is ever forgotten.
 * `interrupted-before-start` is a command a Computer restart settled before it started; it alone may be admitted again.
 */
export const command = sqliteTable(
    "command",
    {
        commandId: text("command_id").primaryKey(),
        harness: text("harness").notNull(),
        sessionId: text("session_id").notNull(),
        commandHash: text("command_hash").notNull(),
        attemptId: text("attempt_id").notNull(),
        admissionOrder: integer("admission_order").notNull(),
        fate: text("fate", {
            enum: [
                "pending",
                "started",
                "cancelled",
                "interrupted-before-start",
                "settled-before-start",
                "settled-after-start",
            ],
        }).notNull(),
        /** When the Agent received the command; only a command that started has one. */
        startedAt: text("started_at"),
    },
    (table) => [
        uniqueIndex("command_admission_order_idx").on(table.admissionOrder),
        index("command_session_idx").on(table.harness, table.sessionId, table.admissionOrder),
        check(
            "command_fate",
            sql`${table.fate} IN ('pending', 'started', 'cancelled', 'interrupted-before-start', 'settled-before-start', 'settled-after-start')`,
        ),
        check(
            "command_started_at",
            sql`(${table.fate} IN ('started', 'settled-after-start')) = (${table.startedAt} IS NOT NULL)`,
        ),
    ],
);
