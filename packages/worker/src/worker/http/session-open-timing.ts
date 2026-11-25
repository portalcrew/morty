import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { clientLocationOf } from "../../contracts/client-location.ts";

import { logger } from "../../infra/logger.ts";

const milliseconds = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(120_000));
const sampleSchema = v.strictObject({
    entry: v.picklist(["navigation", "selection"]),
    outcome: v.picklist(["visible", "empty", "cancelled", "hidden", "timeout", "failed"]),
    elapsedMs: milliseconds,
    openedToRequestMs: v.nullable(milliseconds),
    requestToResponseMs: v.nullable(milliseconds),
    responseToVisibleMs: v.nullable(milliseconds),
});

export const sessionOpenTimingRoutes = new Hono().post(
    "/morty/api/v1/metrics/session-open",
    bodyLimit({ maxSize: 1024, onError: (context) => context.body(null, 413) }),
    async (context) => {
        const request = context.req.raw;
        if (request.headers.get("Origin") !== new URL(request.url).origin) {
            return context.body(null, 403);
        }
        if (request.headers.get("Sec-GPC") === "1" || request.headers.get("DNT") === "1") {
            return context.body(null, 204);
        }
        if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") {
            return context.body(null, 415);
        }
        const parsed = v.safeParse(sampleSchema, await request.json().catch(() => null));
        if (!parsed.success) {
            return context.body(null, 400);
        }
        const sample = parsed.output;
        const { openedToRequestMs, requestToResponseMs, responseToVisibleMs } = sample;
        const sum = (openedToRequestMs ?? 0) + (requestToResponseMs ?? 0) + (responseToVisibleMs ?? 0);
        if (
            (openedToRequestMs === null && requestToResponseMs !== null) ||
            (sample.outcome === "empty" && requestToResponseMs === null) ||
            (sample.outcome === "visible"
                ? responseToVisibleMs === null || requestToResponseMs === null || sample.elapsedMs !== sum
                : responseToVisibleMs !== null) ||
            sum > sample.elapsedMs
        ) {
            return context.body(null, 400);
        }
        const country = clientLocationOf(request)?.country;
        const colo = v.safeParse(v.object({ colo: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/u)) }), request.cf);
        logger.info(
            {
                event: "chat.session.open",
                ...(country && country !== "XX" ? { "client.geo.country.iso_code": country } : {}),
                ...(colo.success ? { reportingColo: colo.output.colo } : {}),
                ...sample,
            },
            "Session open timing",
        );
        return context.body(null, 204);
    },
);
