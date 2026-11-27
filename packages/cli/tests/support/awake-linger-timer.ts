import { AWAKE_LINGER_MILLISECONDS } from "../../src/engine/runtime/power/sleep-prevention.ts";
import { type ScheduledTask, systemTimer, type Timer } from "../../src/engine/util/timer.ts";

/** Lets a scenario end the grace period after work without waiting it out; every other deadline runs on real time. */
export class AwakeLingerTimer implements Timer {
    readonly #pending = new Map<symbol, () => void>();
    #waiters: Array<() => void> = [];

    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        if (milliseconds !== AWAKE_LINGER_MILLISECONDS) {
            return systemTimer.schedule(callback, milliseconds);
        }
        const id = Symbol("awake linger");
        this.#pending.set(id, callback);
        for (const wake of this.#waiters.splice(0)) {
            wake();
        }
        return { cancel: () => this.#pending.delete(id) };
    };

    /** Resolves once a grace period is pending. */
    readonly lingering = async (): Promise<void> => {
        if (this.#pending.size > 0) {
            return;
        }
        await new Promise<void>((resolve) => this.#waiters.push(resolve));
    };

    readonly elapse = (): void => {
        for (const [id, callback] of [...this.#pending]) {
            if (this.#pending.delete(id)) {
                callback();
            }
        }
    };
}
