import type { ComputerConnectionIdentity } from "../entity/computer-connection.ts";
import type { ComputerConnectionStorage } from "../storage/computer-connection-storage.ts";

export class DaemonConnectionService {
    readonly #storage: ComputerConnectionStorage;

    constructor(storage: ComputerConnectionStorage) {
        this.#storage = storage;
    }

    /** The current connection; null when the latest one closed or the generation it was admitted under ended. */
    readonly current = () => this.#storage.read();

    readonly latest = () => this.#storage.latest();

    /** The identity of the next connection: every connection takes a later epoch than any before it. */
    readonly next = (computerId: string): ComputerConnectionIdentity => ({
        computerId,
        connectionEpoch: (this.#storage.latest()?.connectionEpoch ?? 0) + 1,
    });

    readonly isCurrent = (identity: ComputerConnectionIdentity): boolean => this.standing(identity) === "current";

    /**
     * Where a daemon connection stands: still the current one; `replaced` by a later connection or closed; or `ended`
     * because the generation it was admitted under no longer authorizes it.
     */
    readonly standing = (identity: ComputerConnectionIdentity): "current" | "replaced" | "ended" => {
        const latest = this.#storage.latest();
        if (latest?.kind !== "connected" || latest.connectionEpoch !== identity.connectionEpoch) {
            return "replaced";
        }
        return this.#storage.read() === null ? "ended" : "current";
    };

    readonly connected = (identity: ComputerConnectionIdentity, generation: number, now: number): void => {
        this.#storage.connect(identity.connectionEpoch, generation, now);
    };

    readonly disconnected = (connectionEpoch: number, now: number): void => {
        this.#storage.disconnect(connectionEpoch, now);
    };
}
