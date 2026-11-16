import { waitForSharedOperation } from "./wait-for-shared-operation.ts";

/**
 * An operation several requesters share and none of them owns. Each requester waits under its own signal; the
 * operation runs under its own signal, aborted only once every requester has left, so one requester's cancellation
 * never fails the others.
 */
export interface SharedOperation<T> {
    readonly wait: (signal: AbortSignal) => Promise<T>;
    /** The operation's own outcome, for work that must see it end whoever else has left. */
    readonly completion: Promise<T>;
    readonly ended: Promise<void>;
    /** Whether every requester left, so the operation is being cancelled and a new requester must not join it. */
    readonly abandoned: () => boolean;
}

/**
 * Starts `run` with `signal`'s requester as its first waiter, registered before the operation can end or be abandoned.
 * `run` begins after this returns, so it may refer to the operation it belongs to.
 */
export function shareOperation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
): { readonly operation: SharedOperation<T>; readonly first: Promise<T> } {
    const controller = new AbortController();
    let waiting = 0;
    let settled = false;
    const completion = Promise.resolve().then(async () => {
        try {
            return await run(controller.signal);
        } finally {
            settled = true;
        }
    });
    const ended = completion.then(
        () => undefined,
        () => undefined,
    );
    const operation: SharedOperation<T> = {
        completion,
        ended,
        abandoned: () => controller.signal.aborted,
        wait: async (waiter) => {
            waiting += 1;
            try {
                waiter.throwIfAborted();
                return await waitForSharedOperation(completion, waiter);
            } finally {
                waiting -= 1;
                if (waiting === 0 && !settled) {
                    controller.abort(waiter.reason);
                }
            }
        },
    };
    return { operation, first: operation.wait(signal) };
}
