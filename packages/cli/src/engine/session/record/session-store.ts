import { nativeSessionKey } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import type { AcpSessionRow, AcpSessionTable } from "../../storage/session/acp-session-table.ts";
import { MemorySessionEventStore, type SessionEventStore } from "../history/session-event-store.ts";
import { decodeStoredSessionConfigurations, type StoredSessionConfiguration } from "../live/session-configurations.ts";

export class StoredSession {
    readonly target: NativeSessionTarget;
    get harness(): string {
        return this.target.harness;
    }
    readonly configurations: readonly StoredSessionConfiguration[];
    readonly cwd: string;
    get sessionId(): string {
        return this.target.sessionId;
    }
    readonly prompted: boolean;
    readonly title: string;
    readonly updatedAt: string;

    constructor(
        target: NativeSessionTarget,
        cwd: string,
        prompted: boolean,
        title: string,
        updatedAt = new Date().toISOString(),
        configurations: readonly StoredSessionConfiguration[] = [],
    ) {
        this.target = target;
        this.cwd = cwd;
        this.configurations = configurations.map((configuration) => ({ ...configuration }));
        this.prompted = prompted;
        this.title = title;
        this.updatedAt = updatedAt;
    }
}

/** What a live Agent session knows of its Session, which the record follows while the Session is held. */
export interface StoredSessionFacts {
    readonly configurations: readonly StoredSessionConfiguration[];
    readonly prompted: boolean;
    readonly title: string;
}

/** The latest of the given modification times, in canonical form; a time that does not parse is no modification. */
function latestModification(...times: readonly (string | null | undefined)[]): string | null {
    let latest: number | null = null;
    for (const time of times) {
        const parsed = time === null || time === undefined ? Number.NaN : Date.parse(time);
        if (!Number.isNaN(parsed) && (latest === null || parsed > latest)) {
            latest = parsed;
        }
    }
    return latest === null ? null : new Date(latest).toISOString();
}

/**
 * The held Session's record after its facts change. Its modification time is the latest change anyone observed: a
 * change at `modifiedAt` moves it forward, an earlier one (such as an Agent restating an older time) never moves it
 * back, and `null` records facts that are no change to the conversation, such as an Agent reporting its settings.
 */
function updatedSession(held: StoredSession, facts: StoredSessionFacts, modifiedAt: string | null): StoredSession {
    return new StoredSession(
        held.target,
        held.cwd,
        facts.prompted,
        facts.title,
        latestModification(held.updatedAt, modifiedAt) ?? new Date().toISOString(),
        facts.configurations,
    );
}

/**
 * The Sessions this Runtime holds. A record is the Session's existence: `hold` creates it, `update` follows the
 * Session's facts only while it exists, so a Session that was removed is never brought back by a late change, and
 * `remove` ends it.
 */
export interface SessionStore {
    readonly close: () => void;
    readonly events: SessionEventStore;
    readonly hold: (session: StoredSession) => void;
    readonly list: () => readonly StoredSession[];
    readonly read: (target: NativeSessionTarget) => StoredSession | undefined;
    readonly remove: (target: NativeSessionTarget) => void;
    readonly update: (target: NativeSessionTarget, facts: StoredSessionFacts, modifiedAt: string | null) => void;
}

export class MemorySessionStore implements SessionStore {
    readonly events: SessionEventStore;
    readonly #sessions = new Map<string, StoredSession>();

    constructor(events: SessionEventStore = new MemorySessionEventStore()) {
        this.events = events;
    }

    readonly close = (): void => {
        this.#sessions.clear();
        this.events.close();
    };

    readonly list = (): readonly StoredSession[] =>
        [...this.#sessions.values()].toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    readonly read = (target: NativeSessionTarget): StoredSession | undefined =>
        this.#sessions.get(nativeSessionKey(target));

    readonly remove = (target: NativeSessionTarget): void => {
        this.#sessions.delete(nativeSessionKey(target));
        this.events.remove(target);
    };

    readonly hold = (session: StoredSession): void => {
        this.#sessions.set(nativeSessionKey(session.target), session);
    };

    readonly update = (target: NativeSessionTarget, facts: StoredSessionFacts, modifiedAt: string | null): void => {
        const held = this.#sessions.get(nativeSessionKey(target));
        if (held !== undefined) {
            this.#sessions.set(nativeSessionKey(target), updatedSession(held, facts, modifiedAt));
        }
    };
}

function decodeStoredSession(row: AcpSessionRow): StoredSession {
    const decodedConfigurations: unknown = JSON.parse(row.configurations);
    const configurations = decodeStoredSessionConfigurations(decodedConfigurations);
    return new StoredSession(
        { harness: row.harness, sessionId: row.sessionId },
        row.cwd,
        row.prompted,
        row.title,
        row.updatedAt,
        configurations,
    );
}

export class SqliteSessionStore implements SessionStore {
    readonly events: SessionEventStore;
    readonly #table: AcpSessionTable;

    constructor(table: AcpSessionTable, events: SessionEventStore) {
        this.events = events;
        this.#table = table;
    }

    readonly close = (): void => {
        try {
            this.#table.close();
        } finally {
            this.events.close();
        }
    };

    readonly list = (): readonly StoredSession[] => this.#table.list().map(decodeStoredSession);

    readonly read = (target: NativeSessionTarget): StoredSession | undefined => {
        const row = this.#table.read(target);
        return row === undefined ? undefined : decodeStoredSession(row);
    };

    /** The record is the Session's existence, so it goes last: a failed removal leaves a Session that is removed again. */
    readonly remove = (target: NativeSessionTarget): void => {
        this.events.remove(target);
        this.#table.remove(target);
    };

    readonly hold = (session: StoredSession): void => this.#table.upsert(encodeStoredSession(session));

    readonly update = (target: NativeSessionTarget, facts: StoredSessionFacts, modifiedAt: string | null): void => {
        const held = this.read(target);
        if (held !== undefined) {
            this.#table.update(encodeStoredSession(updatedSession(held, facts, modifiedAt)));
        }
    };
}

function encodeStoredSession(session: StoredSession): AcpSessionRow {
    return {
        harness: session.harness,
        configurations: JSON.stringify(session.configurations),
        cwd: session.cwd,
        sessionId: session.sessionId,
        prompted: session.prompted,
        title: session.title,
        updatedAt: session.updatedAt,
    };
}
