import { Hono } from "hono";
import * as v from "valibot";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { RequestError } from "../../http/request-error.ts";

const assetBindingSchema = v.custom<Fetcher>(
    (value) => typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function",
);

// Fallback for direct Worker callers; deployed browser navigations use the assets SPA router.
const paths = ["/setup", "/chat", "/continue"].flatMap((path) => [path, `${path}/`]);

export const webPages = new Hono<{ readonly Bindings: CloudBindings }>().on("GET", paths, async (context) => {
    const assets = v.safeParse(assetBindingSchema, context.env.ASSETS);
    if (!assets.success) {
        throw new RequestError("WEB_ASSETS_UNAVAILABLE", "The application page is unavailable.", 503);
    }
    const request = context.req.raw;
    const response = await assets.output.fetch(
        new Request(new URL("/", request.url), {
            method: request.method,
            headers: request.headers,
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
        }),
    );
    const page = new Response(response.body, response);
    page.headers.set("X-Robots-Tag", "noindex");
    return page;
});
