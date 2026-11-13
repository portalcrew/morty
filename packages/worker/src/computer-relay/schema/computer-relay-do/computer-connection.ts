import { integer, sqliteTable } from "drizzle-orm/sqlite-core";

/**
 * The computer's latest daemon connection and the pairing generation it was admitted under. Each connection takes the
 * next epoch and replaces the row before it; the connection is current until it disconnects or its generation's
 * access ends. Each computer has its own database, so the table holds at most one row.
 */
export const computerConnection = sqliteTable("computer_connection", {
    connectionEpoch: integer("connection_epoch").primaryKey(),
    generation: integer("generation").notNull(),
    connectedAt: integer("connected_at").notNull(),
    disconnectedAt: integer("disconnected_at"),
});
