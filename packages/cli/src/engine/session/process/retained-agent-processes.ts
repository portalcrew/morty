type Resource<P> = { readonly kind: "empty" } | { readonly kind: "ready"; readonly runtime: P };
type Lifecycle<P> =
    | Resource<P>
    | {
          readonly kind: "preparing";
          readonly completion: Promise<P>;
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
    readonly pending = (id: Key): Promise<P> | undefined => {
        const state = this.#entry(id).lifecycle;
        return state.kind === "preparing" ? state.completion : undefined;
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
    readonly prepare = (id: Key, start: () => Promise<P>): Promise<P> => {
        const pending = this.pending(id);
        if (pending !== undefined) {
            return pending;
        }
        const completion = Promise.withResolvers<P>();
        const entry = this.#entry(id);
        this.#write(id, {
            ...entry,
            lifecycle: {
                kind: "preparing",
                completion: completion.promise,
                resource: this.#resource(entry),
            },
        });
        const run = async (): Promise<P> => {
            try {
                return await start();
            } finally {
                const current = this.#entry(id);
                if (current.lifecycle.kind === "preparing" && current.lifecycle.completion === completion.promise) {
                    this.#write(id, { ...current, lifecycle: current.lifecycle.resource });
                }
                this.#events.changed();
            }
        };
        void run().then(completion.resolve, completion.reject);
        return completion.promise;
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
