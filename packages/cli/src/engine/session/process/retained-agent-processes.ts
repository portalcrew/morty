import { waitForSharedOperation } from "../../util/wait-for-shared-operation.ts";

type Resource<P> = { readonly kind: "empty" } | { readonly kind: "ready"; readonly runtime: P };

/**
 * A start in progress, which no one requester owns. Each requester waits for it under its own signal, and the start is
 * aborted only once the last of them has left, so the first requester's cancellation never fails the others.
 */
export interface PendingStart<P> {
    /** Waits for the start; leaving early, by `signal`, only ends this requester's wait. */
    readonly wait: (signal: AbortSignal) => Promise<P>;
    /** The start's own outcome, for work that must see it end whoever else has left. */
    readonly completion: Promise<P>;
}
type Lifecycle<P> =
    | Resource<P>
    | {
          readonly kind: "preparing";
          readonly start: PendingStart<P>;
          readonly resource: Resource<P>;
      };
interface Entry<P> {
    readonly lifecycle: Lifecycle<P>;
    readonly users: number;
}
interface RetainedSessionEvents<P> {
    readonly touch: (runtime: P) => void;
    readonly changed: () => void;
}

/** Tracks reusable Agent processes and their preparation/borrow lifetimes. */
export class RetainedAgentProcesses<P, Key = string> {
    readonly #entries = new Map<string, Entry<P>>();
    readonly #keys = new Map<string, Key>();
    readonly #events: RetainedSessionEvents<P>;
    readonly #key: (id: Key) => string;
    constructor(events: RetainedSessionEvents<P>, key: (id: Key) => string) {
        this.#events = events;
        this.#key = key;
    }

    readonly #entry = (id: Key): Entry<P> =>
        this.#entries.get(this.#key(id)) ?? { lifecycle: { kind: "empty" }, users: 0 };
    readonly #write = (id: Key, entry: Entry<P>): void => {
        if (entry.lifecycle.kind === "empty" && entry.users === 0) {
            this.#entries.delete(this.#key(id));
            this.#keys.delete(this.#key(id));
        } else {
            this.#entries.set(this.#key(id), entry);
            this.#keys.set(this.#key(id), id);
        }
    };
    readonly #resource = (entry: Entry<P>): Resource<P> =>
        entry.lifecycle.kind === "preparing" ? entry.lifecycle.resource : entry.lifecycle;
    readonly get = (id: Key): P | undefined => {
        const resource = this.#resource(this.#entry(id));
        return resource.kind === "ready" ? resource.runtime : undefined;
    };
    readonly pending = (id: Key): PendingStart<P> | undefined => {
        const state = this.#entry(id).lifecycle;
        return state.kind === "preparing" ? state.start : undefined;
    };
    readonly isBusy = (id: Key): boolean => {
        const entry = this.#entry(id);
        return entry.users > 0 || entry.lifecycle.kind === "preparing";
    };
    readonly touch = (id: Key, expected = this.get(id)): void => {
        if (expected !== undefined && this.get(id) === expected) {
            this.#events.touch(expected);
        }
    };
    readonly #setResource = (id: Key, resource: Resource<P>): void => {
        const entry = this.#entry(id);
        this.#write(id, {
            ...entry,
            lifecycle: entry.lifecycle.kind === "preparing" ? { ...entry.lifecycle, resource } : resource,
        });
    };
    readonly retain = (id: Key, runtime: P): void => {
        this.#setResource(id, { kind: "ready", runtime });
    };
    readonly detach = (id: Key, expected: P): void => {
        if (this.get(id) === expected) {
            this.#setResource(id, { kind: "empty" });
        }
    };
    readonly entries = (): readonly (readonly [Key, P])[] => {
        const result: (readonly [Key, P])[] = [];
        for (const id of this.#keys.values()) {
            const runtime = this.get(id);
            if (runtime !== undefined) {
                result.push([id, runtime]);
            }
        }
        return result;
    };
    /** Starts, or joins, the start for `id`; `signal` ends only this requester's wait while others still wait. */
    readonly prepare = (id: Key, start: (signal: AbortSignal) => Promise<P>, signal: AbortSignal): Promise<P> => {
        const pending = this.pending(id);
        if (pending !== undefined) {
            return pending.wait(signal);
        }
        const completion = Promise.withResolvers<P>();
        const controller = new AbortController();
        let waiting = 0;
        let settled = false;
        const started: PendingStart<P> = {
            completion: completion.promise,
            wait: async (waiter) => {
                waiting += 1;
                try {
                    waiter.throwIfAborted();
                    return await waitForSharedOperation(completion.promise, waiter);
                } finally {
                    waiting -= 1;
                    if (waiting === 0 && !settled) {
                        controller.abort(waiter.reason);
                    }
                }
            },
        };
        const entry = this.#entry(id);
        this.#write(id, {
            ...entry,
            lifecycle: { kind: "preparing", start: started, resource: this.#resource(entry) },
        });
        const run = async (): Promise<P> => {
            try {
                return await start(controller.signal);
            } finally {
                settled = true;
                const current = this.#entry(id);
                if (current.lifecycle.kind === "preparing" && current.lifecycle.start === started) {
                    this.#write(id, { ...current, lifecycle: current.lifecycle.resource });
                }
                this.#events.changed();
            }
        };
        // The requester that began the start is its first waiter, registered before the start can end or be abandoned.
        const first = started.wait(signal);
        completion.promise.catch(() => undefined);
        void run().then(completion.resolve, completion.reject);
        return first;
    };
    readonly use = async <T>(id: Key, operation: () => Promise<T>): Promise<T> => {
        const entry = this.#entry(id);
        this.#write(id, { ...entry, users: entry.users + 1 });
        this.touch(id);
        try {
            return await operation();
        } finally {
            const current = this.#entry(id);
            this.#write(id, { ...current, users: current.users - 1 });
            this.touch(id);
            this.#events.changed();
        }
    };
}
