import { type SharedOperation, shareOperation } from "../../util/shared-operation.ts";

/**
 * The id's process: none, one that serves it, or one still being retired. A retiring process may still own what the
 * id's next process needs, such as its native writer, so the next start waits for the retirement to end.
 */
type Resource<P> =
    | { readonly kind: "empty" }
    | { readonly kind: "ready"; readonly runtime: P }
    | { readonly kind: "retiring"; readonly ended: Promise<void> };

type Lifecycle<P> =
    | Resource<P>
    | {
          readonly kind: "preparing";
          readonly start: SharedOperation<P>;
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

export class RetainedAgentProcesses<P, Key = string> {
    readonly #entries = new Map<string, { readonly id: Key; readonly entry: Entry<P> }>();
    readonly #events: RetainedSessionEvents<P>;
    readonly #key: (id: Key) => string;
    constructor(events: RetainedSessionEvents<P>, key: (id: Key) => string) {
        this.#events = events;
        this.#key = key;
    }

    readonly #entry = (id: Key): Entry<P> =>
        this.#entries.get(this.#key(id))?.entry ?? { lifecycle: { kind: "empty" }, users: 0 };
    readonly #write = (id: Key, entry: Entry<P>): void => {
        if (entry.lifecycle.kind === "empty" && entry.users === 0) {
            this.#entries.delete(this.#key(id));
        } else {
            this.#entries.set(this.#key(id), { id, entry });
        }
    };
    readonly #resource = (entry: Entry<P>): Resource<P> =>
        entry.lifecycle.kind === "preparing" ? entry.lifecycle.resource : entry.lifecycle;
    readonly get = (id: Key): P | undefined => {
        const resource = this.#resource(this.#entry(id));
        return resource.kind === "ready" ? resource.runtime : undefined;
    };
    readonly pending = (id: Key): SharedOperation<P> | undefined => {
        const state = this.#entry(id).lifecycle;
        return state.kind === "preparing" ? state.start : undefined;
    };
    readonly activity = (id: Key): { readonly preparing: boolean; readonly borrowers: number } => {
        const entry = this.#entry(id);
        return { preparing: entry.lifecycle.kind === "preparing", borrowers: entry.users };
    };
    readonly isBusy = (id: Key): boolean => {
        const { preparing, borrowers } = this.activity(id);
        return borrowers > 0 || preparing;
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
    readonly retiring = (id: Key): Promise<void> | undefined => {
        const resource = this.#resource(this.#entry(id));
        return resource.kind === "retiring" ? resource.ended : undefined;
    };
    /**
     * Retires `expected`: it stops serving the id before `retire` begins and is the id's retiring process until
     * `retire` settles, whose failure is the caller's. A process that no longer serves the id is retired without
     * affecting the id's current process.
     */
    readonly retire = async (id: Key, expected: P, retire: () => Promise<void>): Promise<void> => {
        if (this.get(id) !== expected) {
            await retire();
            return;
        }
        const ended = Promise.withResolvers<void>();
        const retiring: Resource<P> = { kind: "retiring", ended: ended.promise };
        this.#setResource(id, retiring);
        try {
            await retire();
        } finally {
            if (this.#resource(this.#entry(id)) === retiring) {
                this.#setResource(id, { kind: "empty" });
            }
            ended.resolve();
        }
    };
    readonly entries = (): readonly (readonly [Key, P])[] => {
        const result: (readonly [Key, P])[] = [];
        for (const { id } of this.#entries.values()) {
            const runtime = this.get(id);
            if (runtime !== undefined) {
                result.push([id, runtime]);
            }
        }
        return result;
    };
    readonly prepare = (id: Key, start: (signal: AbortSignal) => Promise<P>, signal: AbortSignal): Promise<P> => {
        const pending = this.pending(id);
        if (pending !== undefined) {
            return pending.wait(signal);
        }
        const { operation: started, first } = shareOperation(async (shared) => {
            try {
                return await start(shared);
            } finally {
                const current = this.#entry(id);
                if (current.lifecycle.kind === "preparing" && current.lifecycle.start === started) {
                    this.#write(id, { ...current, lifecycle: current.lifecycle.resource });
                }
                this.#events.changed();
            }
        }, signal);
        const entry = this.#entry(id);
        this.#write(id, {
            ...entry,
            lifecycle: { kind: "preparing", start: started, resource: this.#resource(entry) },
        });
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
