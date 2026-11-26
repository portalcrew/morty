export interface SleepPreventionHold {
    /** Resolves once the computer may sleep again. */
    readonly release: () => Promise<void>;
}

export interface SleepPrevention {
    readonly hold: () => SleepPreventionHold;
}

/**
 * Keeps the computer awake while any Session works on a prompt, so a person following the work from another device
 * does not find the Computer asleep halfway through it.
 */
export class AwakeWhileWorking {
    readonly #prevention: SleepPrevention;
    #hold: SleepPreventionHold | null = null;

    constructor(prevention: SleepPrevention) {
        this.#prevention = prevention;
    }

    readonly follow = (working: boolean): void => {
        if (working) {
            this.#hold ??= this.#prevention.hold();
            return;
        }
        void this.release();
    };

    readonly release = async (): Promise<void> => {
        const hold = this.#hold;
        this.#hold = null;
        await hold?.release();
    };
}
