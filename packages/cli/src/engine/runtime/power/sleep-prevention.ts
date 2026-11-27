import type { ScheduledTask, Timer } from "../../util/timer.ts";

export interface SleepPreventionHold {
    /** Resolves once the computer may sleep again. */
    readonly release: () => Promise<void>;
}

export interface SleepPrevention {
    /** Never throws: a computer that cannot be held awake only risks sleeping, and the work it protects still runs. */
    readonly hold: () => SleepPreventionHold;
}

/**
 * How long the computer stays held after work ends. Back-to-back turns and bursts of prompts that fail at once then
 * share one hold, instead of starting and stopping an operating system helper for each.
 */
export const AWAKE_LINGER_MILLISECONDS = 30_000;

type Wakefulness =
    | { readonly kind: "asleep" }
    | { readonly kind: "working"; readonly hold: SleepPreventionHold }
    | { readonly kind: "lingering"; readonly hold: SleepPreventionHold; readonly expiry: ScheduledTask };

/**
 * Keeps the computer awake while any Session works on a prompt, so a person following the work from another device
 * does not find the Computer asleep halfway through it.
 */
export class AwakeWhileWorking {
    readonly #prevention: SleepPrevention;
    readonly #timer: Timer;
    #state: Wakefulness = { kind: "asleep" };

    constructor(prevention: SleepPrevention, timer: Timer) {
        this.#prevention = prevention;
        this.#timer = timer;
    }

    readonly follow = (working: boolean): void => {
        const state = this.#state;
        switch (state.kind) {
            case "asleep":
                if (working) {
                    this.#state = { kind: "working", hold: this.#prevention.hold() };
                }
                return;
            case "working":
                if (!working) {
                    this.#state = { kind: "lingering", hold: state.hold, expiry: this.#expire(state.hold) };
                }
                return;
            case "lingering":
                if (working) {
                    state.expiry.cancel();
                    this.#state = { kind: "working", hold: state.hold };
                }
                return;
        }
    };

    /** Lets the computer sleep at once, as when the Runtime stops. */
    readonly release = async (): Promise<void> => {
        const state = this.#state;
        this.#state = { kind: "asleep" };
        switch (state.kind) {
            case "asleep":
                return;
            case "lingering":
                state.expiry.cancel();
                await state.hold.release();
                return;
            case "working":
                await state.hold.release();
                return;
        }
    };

    #expire(hold: SleepPreventionHold): ScheduledTask {
        return this.#timer.schedule(() => {
            if (this.#state.kind === "lingering" && this.#state.hold === hold) {
                this.#state = { kind: "asleep" };
                void hold.release();
            }
        }, AWAKE_LINGER_MILLISECONDS);
    }
}
