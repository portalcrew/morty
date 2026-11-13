import { nativeSessionKey } from "@morty-build/client/native-session";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
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

export interface SessionStore {
    readonly close: () => void;
    readonly events: SessionEventStore;
    readonly list: () => readonly StoredSession[];
    readonly read: (target: NativeSessionTarget) => StoredSession | undefined;
    readonly remove: (target: NativeSessionTarget) => void;
    readonly write: (session: StoredSession) => void;
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

    readonly write = (session: StoredSession): void => {
        this.#sessions.set(nativeSessionKey(session.target), session);
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

    readonly write = (session: StoredSession): void => {
        this.#table.upsert({
            harness: session.harness,
            configurations: JSON.stringify(session.configurations),
            cwd: session.cwd,
            sessionId: session.sessionId,
            prompted: session.prompted,
            title: session.title,
            updatedAt: session.updatedAt,
        });
    };
}
