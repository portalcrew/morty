export interface Clock {
    readonly now: () => number;
    readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

// Timers hold their delay in a signed 32-bit integer and run a longer one at once, so a longer wait is taken in steps.
const LONGEST_TIMER_MILLISECONDS = 2_147_483_647;

export const systemClock: Clock = {
    now: () => Date.now(),
    sleep: (milliseconds, signal) =>
        new Promise<void>((resolve, reject) => {
            signal.throwIfAborted();
            const until = Date.now() + milliseconds;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const abort = () => {
                clearTimeout(timer);
                reject(signal.reason);
            };
            const wait = (remaining: number): void => {
                timer = setTimeout(
                    () => {
                        const left = until - Date.now();
                        if (left > 0) {
                            wait(left);
                            return;
                        }
                        signal.removeEventListener("abort", abort);
                        resolve();
                    },
                    Math.min(remaining, LONGEST_TIMER_MILLISECONDS),
                );
            };
            wait(milliseconds);
            signal.addEventListener("abort", abort, { once: true });
        }),
};
