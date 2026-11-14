/** Owned by the Computer's Durable Object so requests share one queue per Session. */
export class ManagedSessionOperations {
    readonly #pending = new Map<string, Promise<void>>();

    readonly run = async <Result>(
        sessionKey: string,
        signal: AbortSignal,
        operation: () => Promise<Result>,
    ): Promise<Result> => {
        signal.throwIfAborted();
        const previous = this.#pending.get(sessionKey) ?? Promise.resolve();
        const finished = Promise.withResolvers<void>();
        // A cancelled waiter must not let its successor overtake the operation ahead of it.
        const pending = previous.then(() => finished.promise);
        this.#pending.set(sessionKey, pending);
        const cancelled = Promise.withResolvers<never>();
        const abort = (): void => cancelled.reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        try {
            await Promise.race([previous, cancelled.promise]);
            signal.throwIfAborted();
            return await operation();
        } finally {
            signal.removeEventListener("abort", abort);
            finished.resolve();
            void pending.then(() => {
                if (this.#pending.get(sessionKey) === pending) {
                    this.#pending.delete(sessionKey);
                }
            });
        }
    };
}
