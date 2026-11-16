import { NativeSessionSet } from "@portalcrew/morty-client/native-session";
import { decodeSessionEvent, type NativeSessionTarget, type SessionEvent } from "@portalcrew/morty-client/protocol";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";
import { sessionEvent } from "../../schema/session-event-cache/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const cachedEventRowSchema = z.object({ eventJson: z.string() });
const cachedEventOrdinalRowSchema = z.object({ eventJson: z.string(), ordinal: z.number().int().positive() });

const ofSession = (target: NativeSessionTarget) =>
    and(eq(sessionEvent.harness, target.harness), eq(sessionEvent.sessionId, target.sessionId));

interface SessionEventCacheBatch {
    readonly events: readonly { readonly event: SessionEvent; readonly ordinal: number }[];
    readonly sessionGenerationId: string;
    readonly sessionTarget: NativeSessionTarget;
}

export class SessionEventCacheTable {
    readonly #database: NodeSQLiteDatabase;
    readonly #ignoredPersistedSessions = new NativeSessionSet();
    readonly #localDatabase: LocalSqliteDatabase;
    #isAvailable = true;

    constructor(localDatabase: LocalSqliteDatabase) {
        this.#localDatabase = localDatabase;
        this.#database = localDatabase.orm;
        try {
            this.#localDatabase.transaction(() => this.#database.delete(sessionEvent).run());
            // Reclaim the space left by the previous process so the cache file
            // tracks live rows instead of its historical high-water mark.
            this.#localDatabase.exec("VACUUM");
            this.#checkpoint();
        } catch (error) {
            this.#localDatabase.close();
            throw error;
        }
    }

    get isAvailable(): boolean {
        return this.#isAvailable;
    }

    /**
     * Persists materialized events, overwriting rows that were read back into
     * memory and merged since they were last written.
     */
    readonly insert = (batches: readonly SessionEventCacheBatch[]): boolean => {
        if (!this.#isAvailable) {
            return false;
        }
        const values = batches.flatMap((batch) =>
            batch.events.map(({ event, ordinal }) => ({
                eventJson: JSON.stringify(event),
                eventId: event.eventId,
                generationId: batch.sessionGenerationId,
                ordinal,
                harness: batch.sessionTarget.harness,
                sessionId: batch.sessionTarget.sessionId,
            })),
        );
        if (values.length === 0) {
            return true;
        }
        try {
            this.#localDatabase.transaction(() => {
                for (let offset = 0; offset < values.length; offset += 200) {
                    this.#database
                        .insert(sessionEvent)
                        .values(values.slice(offset, offset + 200))
                        .onConflictDoUpdate({
                            target: [sessionEvent.harness, sessionEvent.sessionId, sessionEvent.eventId],
                            set: { eventJson: sql`excluded.event_json` },
                        })
                        .run();
                }
            });
            return true;
        } catch (cause) {
            this.#disableWrites(cause);
            return false;
        }
    };

    /**
     * Reads persisted events back by identifier so merges can target events
     * whose payloads were dropped from memory. The rows stay in place; the
     * next flush overwrites them with the merged payloads.
     */
    readonly readByEventIds = (
        sessionTarget: NativeSessionTarget,
        sessionGenerationId: string,
        eventIds: readonly string[],
    ): ReadonlyMap<string, SessionEvent> => {
        if (eventIds.length === 0 || this.#ignoredPersistedSessions.has(sessionTarget)) {
            return new Map();
        }
        let rows: { readonly eventId: string; readonly eventJson: string }[];
        try {
            rows = this.#database
                .select({ eventId: sessionEvent.eventId, eventJson: sessionEvent.eventJson })
                .from(sessionEvent)
                .where(
                    and(
                        eq(sessionEvent.generationId, sessionGenerationId),
                        ofSession(sessionTarget),
                        inArray(sessionEvent.eventId, eventIds),
                    ),
                )
                .all();
        } catch (cause) {
            this.#disableWrites(cause);
            return new Map();
        }
        const resolved = new Map<string, SessionEvent>();
        for (const row of rows) {
            // A row that no longer decodes is reported as missing so a single
            // incompatible row degrades one merge instead of all persistence.
            try {
                resolved.set(row.eventId, decodeSessionEvent(JSON.parse(cachedEventRowSchema.parse(row).eventJson)));
            } catch {
                // Keep the undecodable row unresolved.
            }
        }
        return resolved;
    };

    readonly read = (
        sessionTarget: NativeSessionTarget,
        sessionGenerationId: string,
        startOrdinal: number,
        endOrdinal: number,
    ): readonly { readonly event: SessionEvent; readonly ordinal: number }[] => {
        if (this.#ignoredPersistedSessions.has(sessionTarget)) {
            return [];
        }
        return this.#database
            .select({ eventJson: sessionEvent.eventJson, ordinal: sessionEvent.ordinal })
            .from(sessionEvent)
            .where(
                and(
                    eq(sessionEvent.generationId, sessionGenerationId),
                    ofSession(sessionTarget),
                    gte(sessionEvent.ordinal, startOrdinal),
                    lte(sessionEvent.ordinal, endOrdinal),
                ),
            )
            .orderBy(asc(sessionEvent.ordinal))
            .all()
            .map((value) => {
                const row = cachedEventOrdinalRowSchema.parse(value);
                return { event: decodeSessionEvent(JSON.parse(row.eventJson)), ordinal: row.ordinal };
            });
    };

    readonly delete = (sessionTarget: NativeSessionTarget, sessionGenerationId?: string): void => {
        if (!this.#isAvailable) {
            this.#ignoredPersistedSessions.add(sessionTarget);
            return;
        }
        try {
            this.#database
                .delete(sessionEvent)
                .where(
                    sessionGenerationId === undefined
                        ? ofSession(sessionTarget)
                        : and(eq(sessionEvent.generationId, sessionGenerationId), ofSession(sessionTarget)),
                )
                .run();
            this.#ignoredPersistedSessions.delete(sessionTarget);
        } catch (cause) {
            this.#isAvailable = false;
            this.#ignoredPersistedSessions.add(sessionTarget);
            console.warn("Morty V2 Session event cache writes are unavailable; retaining events in memory", cause);
        }
    };

    readonly close = (): void => {
        if (this.#isAvailable) {
            // Truncating the write-ahead log is best effort; closing the
            // database handle must happen even when it fails.
            try {
                this.#checkpoint();
            } catch (cause) {
                console.warn("Morty V2 Session event cache checkpoint on close failed", cause);
            }
        }
        this.#localDatabase.close();
        this.#ignoredPersistedSessions.clear();
    };

    readonly #checkpoint = (): void => {
        this.#localDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    };

    readonly #disableWrites = (cause: unknown): void => {
        this.#isAvailable = false;
        console.warn("Morty V2 Session event cache writes are unavailable; retaining events in memory", cause);
    };
}
