import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The computer's latest daemon connection and the pairing generation it was admitted under. Each connection takes the
 * next epoch; the connection is current until it disconnects or its generation's access ends.
 */
export const computerConnection = sqliteTable("computer_connection", {
    computerId: text("computer_id").primaryKey(),
    generation: integer("generation").notNull(),
    connectionEpoch: integer("connection_epoch").notNull(),
    connectedAt: integer("connected_at").notNull(),
    disconnectedAt: integer("disconnected_at"),
});
