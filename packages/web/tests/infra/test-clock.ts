import type { Clock } from "../../src/services/time/clock.ts";

/** A separate application clock: network I/O and Worker authentication keep their own clocks. */
export class TestClock implements Clock {
    #now: number;
    readonly #timers = new Set<{ readonly at: number; readonly resolve: () => void }>();
    readonly #scheduled = new Set<{ readonly milliseconds: number; readonly ready: () => void }>();

    constructor(now: string) {
        this.#now = Date.parse(now);
        if (!Number.isFinite(this.#now)) {
            throw new Error("Expected an explicit clock origin");
        }
    }
    readonly now = (): number => this.#now;
    /** How many sleeps are waiting for time to advance. */
    readonly pendingSleeps = (): number => this.#timers.size;
    readonly sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
        new Promise((resolve, reject) => {
            signal.throwIfAborted();
            const abort = () => {
                this.#timers.delete(timer);
                reject(signal.reason);
            };
            const timer = {
                at: this.#now + milliseconds,
                resolve: () => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                },
            };
            this.#timers.add(timer);
            signal.addEventListener("abort", abort, { once: true });
            for (const scheduled of this.#scheduled) {
                if (milliseconds > 0 && milliseconds <= scheduled.milliseconds) {
                    scheduled.ready();
                }
            }
        });
    /** Coordinates a clock advance with a retry registering a sleep within that advance. */
    readonly waitForSleep = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if ([...this.#timers].some((timer) => timer.at > this.#now && timer.at - this.#now <= milliseconds)) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                this.#scheduled.delete(scheduled);
                signal.removeEventListener("abort", aborted);
            };
            const aborted = () => {
                cleanup();
                reject(signal.reason);
            };
            const scheduled = {
                milliseconds,
                ready: () => {
                    cleanup();
                    resolve();
                },
            };
            this.#scheduled.add(scheduled);
            signal.addEventListener("abort", aborted, { once: true });
        });
    };
    readonly advanceBy = (milliseconds: number): void => {
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
            throw new Error("Expected a nonnegative clock advance");
        }
        this.#now += milliseconds;
        for (const timer of this.#timers) {
            if (timer.at <= this.#now) {
                this.#timers.delete(timer);
                timer.resolve();
            }
        }
    };
}
