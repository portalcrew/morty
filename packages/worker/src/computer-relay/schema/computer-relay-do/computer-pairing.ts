import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One pairing generation of the computer: the request that started it. Pairing the computer again starts a new
 * generation; an earlier one keeps its own facts. The latest generation is the computer's current one.
 */
export const computerPairing = sqliteTable("computer_pairings", {
    generation: integer("generation").primaryKey({ autoIncrement: true }),
    pairingCodeHash: text("pairing_code_hash").notNull().unique(),
    pollTokenHash: text("poll_token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    // Each computer has its own database, so the key's namespace is the database boundary.
    creationIdempotencyKey: text("creation_idempotency_key").notNull().unique(),
});

/** The daemon that claimed a generation's pairing code, and the Agents it currently reports. */
export const computerRegistration = sqliteTable("computer_registrations", {
    generation: integer("generation").primaryKey(),
    // Keep the persisted column name so retained registrations remain readable.
    computerName: text("machine_name").notNull(),
    workspaceName: text("workspace_name").notNull(),
    agentsJson: text("agents_json").notNull(),
});

/** When a generation's access ended. Only an ended generation can be followed by a new one. */
export const computerRevocation = sqliteTable("computer_revocations", {
    generation: integer("generation").primaryKey(),
    revokedAt: integer("revoked_at").notNull(),
});

/** A generation's daemon credential, rotated on every connection; `tokenHash` authenticates now. */
export const daemonCredential = sqliteTable("daemon_credentials", {
    generation: integer("generation").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
});

/**
 * Every credential a rotation replaced, with the successor that replaced it. Presenting a retired credential with any
 * other successor means a copy of it is in use elsewhere.
 */
export const retiredDaemonCredential = sqliteTable(
    "retired_daemon_credentials",
    {
        tokenHash: text("token_hash").primaryKey(),
        generation: integer("generation").notNull(),
        successorHash: text("successor_hash").notNull(),
    },
    (table) => [index("retired_daemon_credentials_generation").on(table.generation)],
);
