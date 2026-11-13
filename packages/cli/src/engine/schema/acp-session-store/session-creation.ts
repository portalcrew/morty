import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The receipt of a finished creation, not a provisional conversation identity. A row whose result is NULL was written by
 * a Runtime that recorded a creation before it finished; no creation finished, so it answers nothing.
 */
export const sessionCreation = sqliteTable("session_creation", {
    operationId: text("operation_id").primaryKey(),
    requestHash: text("request_hash").notNull(),
    resultJson: text("result_json"),
});
