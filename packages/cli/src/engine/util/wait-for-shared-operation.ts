/** A cancelled borrower stops waiting without cancelling a shared operation. */
export async function waitForSharedOperation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const cancelled = Promise.withResolvers<never>();
    const abort = (): void => cancelled.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
        return await Promise.race([pending, cancelled.promise]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}
