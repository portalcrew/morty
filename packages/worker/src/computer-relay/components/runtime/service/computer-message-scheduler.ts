const CONCURRENCY = 8;
const PENDING_LIMIT = 512;

export class ComputerMessageSchedulerCapacityError extends Error {
    readonly code = "computer_message_queue_full";

    constructor(limit: number) {
        super(`Computer message queue reached its limit of ${limit}`);
        this.name = "ComputerMessageSchedulerCapacityError";
    }
}

class ComputerMessageSlot {
    readonly #releaseSlot: () => void;
    #released = false;

    constructor(releaseSlot: () => void) {
        this.#releaseSlot = releaseSlot;
    }

    readonly release = (): void => {
        if (this.#released) {
            return;
        }
        this.#released = true;
        this.#releaseSlot();
    };
}

class ComputerMessageSlotWaiter {
    readonly completion = Promise.withResolvers<ComputerMessageSlot>();
    readonly signal: AbortSignal;

    constructor(signal: AbortSignal) {
        this.signal = signal;
    }

    readonly cancel = (): void => {
        this.completion.reject(this.signal.reason);
    };
}

class ComputerMessageConcurrency {
    #active = 0;
    readonly #waiters: ComputerMessageSlotWaiter[] = [];

    readonly acquire = async (signal: AbortSignal): Promise<ComputerMessageSlot> => {
        signal.throwIfAborted();
        if (this.#active < CONCURRENCY) {
            this.#active += 1;
            return new ComputerMessageSlot(this.#release);
        }

        const waiter = new ComputerMessageSlotWaiter(signal);
        this.#waiters.push(waiter);
        signal.addEventListener("abort", waiter.cancel, { once: true });
        try {
            return await waiter.completion.promise;
        } finally {
            signal.removeEventListener("abort", waiter.cancel);
            const waitingIndex = this.#waiters.indexOf(waiter);
            if (waitingIndex >= 0) {
                this.#waiters.splice(waitingIndex, 1);
            }
        }
    };

    readonly #release = (): void => {
        while (this.#waiters.length > 0) {
            const waiter = this.#waiters.shift();
            if (waiter === undefined || waiter.signal.aborted) {
                continue;
            }
            waiter.completion.resolve(new ComputerMessageSlot(this.#release));
            return;
        }
        this.#active -= 1;
    };
}

function waitForComputerMessage(completion: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const result = Promise.withResolvers<void>();
    const cancel = (): void => result.reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    void completion.then(
        () => {
            signal.removeEventListener("abort", cancel);
            result.resolve();
        },
        (error: unknown) => {
            signal.removeEventListener("abort", cancel);
            result.reject(error);
        },
    );
    return result.promise;
}

export class ComputerMessageScheduler {
    readonly #concurrency = new ComputerMessageConcurrency();
    readonly #lanes = new Map<string, Promise<void>>();
    readonly #operations = new Set<Promise<void>>();
    #pending = 0;

    /** Runs `task` after every earlier task on its lane, so tasks on a lane run in the order they were scheduled. */
    readonly run = async (lane: string, signal: AbortSignal, task: () => Promise<void>): Promise<void> => {
        signal.throwIfAborted();
        if (this.#pending >= PENDING_LIMIT) {
            throw new ComputerMessageSchedulerCapacityError(PENDING_LIMIT);
        }
        this.#pending += 1;

        const previous = this.#lanes.get(lane) ?? Promise.resolve();
        const operation = (async (): Promise<void> => {
            await waitForComputerMessage(previous, signal);
            const slot = await this.#concurrency.acquire(signal);
            try {
                signal.throwIfAborted();
                await task();
            } finally {
                slot.release();
            }
        })();
        const tail = operation.catch(() => undefined);
        this.#lanes.set(lane, tail);
        this.#operations.add(tail);

        try {
            await operation;
        } finally {
            this.#pending -= 1;
            this.#operations.delete(tail);
            if (this.#lanes.get(lane) === tail) {
                this.#lanes.delete(lane);
            }
        }
    };

    readonly idle = async (signal: AbortSignal): Promise<void> => {
        while (this.#operations.size > 0) {
            await waitForComputerMessage(
                Promise.all(this.#operations).then(() => undefined),
                signal,
            );
        }
    };
}
