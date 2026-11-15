import { createHash } from "node:crypto";
import { join } from "node:path";
import { acpSessionStoreMigrations } from "../../generated/acp-session-store-migrations.ts";
import { computerReplayLedgerMigrations } from "../../generated/computer-replay-ledger-migrations.ts";
import { sessionEventCacheMigrations } from "../../generated/session-event-cache-migrations.ts";
import { LocalSqliteDatabase } from "./local-sqlite-database.ts";

export interface ComputerSessionDatabasePaths {
    readonly events: string;
    readonly sessions: string;
}

/** Each computer keeps its saved sessions and its spilled session events in its own files. */
export function computerSessionDatabasePaths(stateDirectory: string, computerId: string): ComputerSessionDatabasePaths {
    const computerHash = createHash("sha256").update(computerId).digest("hex");
    return {
        events: join(stateDirectory, "sessions", `${computerHash}.events.sqlite`),
        sessions: join(stateDirectory, "sessions", `${computerHash}.sqlite`),
    };
}

export const openAcpSessionDatabase = (path: string): LocalSqliteDatabase => {
    return new LocalSqliteDatabase(path, "ACP Session database", acpSessionStoreMigrations);
};

export const openComputerReplayLedgerDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "Computer replay ledger", computerReplayLedgerMigrations);

export const openSessionEventCacheDatabase = (path: string): LocalSqliteDatabase =>
    new LocalSqliteDatabase(path, "V2 Session event cache", sessionEventCacheMigrations, [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = OFF",
        "PRAGMA auto_vacuum = FULL",
    ]);
