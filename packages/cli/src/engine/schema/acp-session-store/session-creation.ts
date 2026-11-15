import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The receipt of a finished creation: which Session the operation created. A retry of the operation is answered with
 * that Session as it stands then, never with a copy of what it was; a creation that did not finish has no receipt.
 */
export const sessionCreation = sqliteTable("session_creation", {
    operationId: text("operation_id").primaryKey(),
    requestHash: text("request_hash").notNull(),
    harness: text("harness").notNull(),
    sessionId: text("session_id").notNull(),
});
