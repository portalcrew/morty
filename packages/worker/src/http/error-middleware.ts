import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { ValiError } from "valibot";
import { type HttpErrorJson, toHttpError } from "../contracts/http-error.ts";
import { requestLogContext } from "../infra/log-diagnostics.ts";
import { logger } from "../infra/logger.ts";

function errorResponse(error: unknown): HttpErrorJson {
    return error instanceof ValiError
        ? { body: { error: { code: "INVALID_REQUEST", message: "The request is invalid." } }, status: 400 }
        : toHttpError(error);
}

/**
 * The one error boundary of every Morty route. Cancellation propagates; any other failure is logged and answered
 * with its typed error, or a sanitized internal error. Hono's boundary replaces even a response prepared before a
 * final authorization check failed.
 */
export function errorHandler(error: unknown, context: Context): Response {
    if (context.req.raw.signal.aborted) {
        throw error;
    }
    logger.error(
        { ...requestLogContext(context.req.raw), err: error, event: "request_failed" },
        "Morty request failed",
    );
    const response = errorResponse(error);
    const result = Response.json(response.body, {
        status: response.status,
        headers: { "Cache-Control": "no-store", ...response.headers },
    });
    return context.newResponse(result.body, result);
}

/** Mounted routes need an error handler: the host can consume exceptions before upstream middleware sees them. */
export const errorMiddleware = createMiddleware(async (context, next) => {
    try {
        return await next();
    } catch (error) {
        return errorHandler(error, context);
    }
});

export function rethrowHonoError(error: Error): never {
    throw error;
}
