import type { Context, Env } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { RequestError } from "./request-error.ts";

export function bodyParser<TEnvironment extends Env, TSchema extends v.GenericSchema<unknown, object>>(
    schema: TSchema,
    reader?: (context: Context<TEnvironment>) => Promise<unknown>,
) {
    return createMiddleware<
        TEnvironment,
        string,
        { in: { json: v.InferInput<TSchema> }; out: { json: v.InferOutput<TSchema> } }
    >(async (context, next) => {
        context.req.addValidatedData(
            "json",
            v.parse(schema, await (reader?.(context) ?? readJsonBody(context.req.raw))),
        );
        await next();
    });
}

type JsonRequest = Pick<Request, "headers" | "json" | "signal">;

export function readJsonTextBody(body: string, headers: Headers, signal: AbortSignal): unknown {
    if (headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new RequestError("INVALID_REQUEST", "A JSON request is required.", 400);
    }
    try {
        const result: unknown = JSON.parse(body);
        signal.throwIfAborted();
        return result;
    } catch (cause) {
        signal.throwIfAborted();
        if (cause instanceof SyntaxError) {
            throw new RequestError("INVALID_REQUEST", "The JSON request is invalid.", 400, { cause });
        }
        throw cause;
    }
}

export async function readJsonBody(request: JsonRequest): Promise<unknown> {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new RequestError("INVALID_REQUEST", "A JSON request is required.", 400);
    }
    try {
        const body: unknown = await request.json();
        request.signal.throwIfAborted();
        return body;
    } catch (cause) {
        request.signal.throwIfAborted();
        if (cause instanceof SyntaxError) {
            throw new RequestError("INVALID_REQUEST", "The JSON request is invalid.", 400, { cause });
        }
        throw cause;
    }
}
