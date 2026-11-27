import type { SleepPrevention } from "../../src/engine/runtime/power/sleep-prevention.ts";

/** Stands in for the operating system's power management and remembers how the Runtime held the computer awake. */
export class RecordingSleepPrevention implements SleepPrevention {
    #live = 0;
    #holds = 0;
    #sleepers: Array<() => void> = [];

    get awake(): boolean {
        return this.#live > 0;
    }

    /** How many times the computer was held awake: overlapping work shares one hold. */
    get holds(): number {
        return this.#holds;
    }

    readonly hold = () => {
        this.#live += 1;
        this.#holds += 1;
        let released = false;
        return {
            release: async () => {
                if (released) {
                    return;
                }
                released = true;
                this.#live -= 1;
                if (this.#live === 0) {
                    for (const wake of this.#sleepers.splice(0)) {
                        wake();
                    }
                }
            },
        };
    };

    /** Resolves once nothing holds the computer awake. */
    readonly asleep = async (): Promise<void> => {
        if (this.#live === 0) {
            return;
        }
        await new Promise<void>((resolve) => this.#sleepers.push(resolve));
    };
}
