import { MemorySessionEventStore, type SessionEventStore } from "../../session/history/session-event-store.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { NativeSessionPreviewKey } from "../adapter/query-scope.ts";

export interface HistoryPreviewSnapshot {
    readonly events: SessionEventStore;
    readonly close: () => void;
}

export function memoryHistoryPreviewSnapshot(): HistoryPreviewSnapshot {
    const events = new MemorySessionEventStore();
    return { events, close: events.close };
}

export class NativeHistoryPreviewSnapshots {
    readonly #capacity: number;
    readonly #snapshots = new Map<NativeSessionPreviewKey, HistoryPreviewSnapshot>();
    readonly create: () => HistoryPreviewSnapshot;

    constructor(create: () => HistoryPreviewSnapshot, capacity: number) {
        this.create = create;
        this.#capacity = capacity;
    }

    /** Only completed readers enter retention; active readers keep ownership of their own cache. */
    readonly retain = (key: NativeSessionPreviewKey, snapshot: HistoryPreviewSnapshot): void => {
        this.#snapshots.get(key)?.close();
        this.#snapshots.delete(key);
        this.#snapshots.set(key, snapshot);
        while (this.#snapshots.size > this.#capacity) {
            const oldest = this.#snapshots.entries().next();
            if (oldest.done) {
                return;
            }
            const [key, expired] = oldest.value;
            this.#snapshots.delete(key);
            expired.close();
        }
    };

    readonly get = (key: NativeSessionPreviewKey): SessionEventStore => {
        const store = this.#snapshots.get(key);
        if (store === undefined) {
            throw new AcpExecutionError("The native event cursor is invalid", {}, "invalid_native_session_response");
        }
        this.#snapshots.delete(key);
        this.#snapshots.set(key, store);
        return store.events;
    };

    readonly close = (): void => {
        for (const store of this.#snapshots.values()) {
            store.close();
        }
        this.#snapshots.clear();
    };
}
