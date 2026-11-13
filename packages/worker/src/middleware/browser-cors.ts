import { createMiddleware } from "hono/factory";
import { ComputerManagementError } from "../contracts/computer-management.ts";

function browserCorsHeaders(origin: string, methods: readonly string[], headers: readonly string[]): Headers {
    return new Headers({
        "access-control-allow-headers": headers.join(", "),
        "access-control-allow-methods": [...methods, "OPTIONS"].join(", "),
        "access-control-allow-origin": origin,
        "access-control-expose-headers": "content-length, content-type, x-morty-byte-length, x-morty-file-name",
        "access-control-max-age": "600",
        vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    });
}

export function createBrowserCors(
    ctx: { readonly allowedOrigins: ReadonlySet<string> },
    methods: readonly string[],
    headers: readonly string[],
) {
    return createMiddleware(async (context, next) => {
        const origin = context.req.header("origin") ?? "";
        const allowedOrigins = ctx.allowedOrigins;
        if (origin.length > 0 && !allowedOrigins.has("*") && !allowedOrigins.has(origin)) {
            throw new ComputerManagementError("browser_origin_denied", "The browser origin is not allowed", 403);
        }
        if (context.req.method === "OPTIONS") {
            if (origin.length === 0) {
                throw new ComputerManagementError("browser_origin_denied", "The browser origin is not allowed", 403);
            }
            const requestedMethod = context.req.header("access-control-request-method") ?? "";
            const requestedHeaders = (context.req.header("access-control-request-headers") ?? "")
                .split(",")
                .map((header) => header.trim().toLowerCase())
                .filter((header) => header.length > 0);
            if (!methods.includes(requestedMethod) || requestedHeaders.some((header) => !headers.includes(header))) {
                throw new ComputerManagementError(
                    "browser_preflight_denied",
                    "The browser preflight request is not allowed",
                    403,
                );
            }
            return new Response(null, { headers: browserCorsHeaders(origin, methods, headers), status: 204 });
        }
        if (origin.length > 0) {
            for (const [name, value] of browserCorsHeaders(origin, methods, headers)) {
                context.header(name, value);
            }
        }
        await next();
        if (origin.length > 0) {
            context.res = new Response(context.res.body, context.res);
            for (const [name, value] of browserCorsHeaders(origin, methods, headers)) {
                context.res.headers.set(name, value);
            }
        }
        return context.res;
    });
}
