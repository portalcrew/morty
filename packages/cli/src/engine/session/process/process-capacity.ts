class AcpProcessCapacityLease {
    readonly #releaseCapacity: () => void;
    #released = false;

    constructor(releaseCapacity: () => void) {
        this.#releaseCapacity = releaseCapacity;
    }

    readonly release = (): void => {
        if (this.#released) {
            return;
        }
        this.#released = true;
        this.#releaseCapacity();
    };
}

class AcpProcessCapacityWaiter {
    readonly completion = Promise.withResolvers<AcpProcessCapacityLease>();
    readonly signal: AbortSignal;

    constructor(signal: AbortSignal) {
        this.signal = signal;
    }

    readonly cancel = (): void => {
        try {
            this.signal.throwIfAborted();
        } catch (error) {
            this.completion.reject(error);
        }
    };
}

export class AcpProcessCapacityLock {
    #locked = false;
    readonly #waiters: AcpProcessCapacityWaiter[] = [];

    readonly acquire = async (signal: AbortSignal): Promise<AcpProcessCapacityLease> => {
        signal.throwIfAborted();
        if (!this.#locked) {
            this.#locked = true;
            return new AcpProcessCapacityLease(this.#release);
        }

        const waiter = new AcpProcessCapacityWaiter(signal);
        this.#waiters.push(waiter);
        signal.addEventListener("abort", waiter.cancel, { once: true });
        if (signal.aborted) {
            waiter.cancel();
        }
        try {
            return await waiter.completion.promise;
        } finally {
            signal.removeEventListener("abort", waiter.cancel);
            const index = this.#waiters.indexOf(waiter);
            if (index >= 0) {
                this.#waiters.splice(index, 1);
            }
        }
    };

    readonly #release = (): void => {
        while (this.#waiters.length > 0) {
            const waiter = this.#waiters.shift();
            if (waiter === undefined || waiter.signal.aborted) {
                continue;
            }
            waiter.completion.resolve(new AcpProcessCapacityLease(this.#release));
            return;
        }
        this.#locked = false;
    };
}
