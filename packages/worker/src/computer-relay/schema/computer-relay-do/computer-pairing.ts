import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AgentDescriptor } from "../../../contracts/relay/pairing.ts";

export const computerPairing = sqliteTable("computer_pairings", {
    generation: integer("generation").primaryKey({ autoIncrement: true }),
    pairingCodeHash: text("pairing_code_hash").notNull().unique(),
    pollTokenHash: text("poll_token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    // Each computer has its own database, so the key's namespace is the database boundary.
    creationIdempotencyKey: text("creation_idempotency_key").notNull().unique(),
});

export const computerRegistration = sqliteTable("computer_registrations", {
    generation: integer("generation").primaryKey(),
    // Keep the persisted column name so retained registrations remain readable.
    computerName: text("machine_name").notNull(),
    workspaceName: text("workspace_name").notNull(),
});

// Written by every daemon report; a generation that never reported has no row.
export const computerAgentCatalog = sqliteTable("computer_agent_catalogs", {
    generation: integer("generation").primaryKey(),
    agents: text("agents", { mode: "json" }).$type<readonly AgentDescriptor[]>().notNull(),
});

export const computerRevocation = sqliteTable("computer_revocations", {
    generation: integer("generation").primaryKey(),
    revokedAt: integer("revoked_at").notNull(),
});

export const daemonCredential = sqliteTable("daemon_credentials", {
    generation: integer("generation").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
});

export const retiredDaemonCredential = sqliteTable(
    "retired_daemon_credentials",
    {
        tokenHash: text("token_hash").primaryKey(),
        generation: integer("generation").notNull(),
        successorHash: text("successor_hash").notNull(),
    },
    (table) => [index("retired_daemon_credentials_generation").on(table.generation)],
);
