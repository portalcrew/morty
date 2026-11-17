import type { Env, MiddlewareHandler } from "hono";
import { RequestDeadline } from "../http/request-deadline.ts";

interface RequestSignalEnvironment extends Env {
    readonly Variables: { readonly signal: AbortSignal };
}

/**
 * Owns the request's deadline. Once it expires, the request fails with the deadline's own TimeoutError, whatever an
 * inner layer made of its abort.
 */
export function requestTimeoutMiddleware<TEnvironment extends RequestSignalEnvironment>(
    timeoutMilliseconds: number,
): MiddlewareHandler<TEnvironment> {
    return async (context, next) => {
        const requestSignal = context.req.raw.signal;
        using deadline = new RequestDeadline(requestSignal, timeoutMilliseconds);
        const signal = deadline.signal;
        context.set("signal", signal);
        try {
            await next();
        } catch (error) {
            if (!requestSignal.aborted) {
                signal.throwIfAborted();
            }
            throw error;
        }
    };
}
