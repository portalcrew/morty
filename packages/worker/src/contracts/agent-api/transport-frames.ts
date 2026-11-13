import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import * as v from "valibot";

// The JSON text frames of the Computer WebSocket transport. The transport reads frames with these limits, and the
// published AsyncAPI description is generated from the schemas below.

export const REQUEST_KIND = "http.request";
export const RESPONSE_KIND = "http.response";
export const ERROR_KIND = "http.error";
export const CANCEL_KIND = "http.cancel";
export const EVENT_SUBSCRIBE_KIND = "session.events.subscribe";
export const EVENT_UNSUBSCRIBE_KIND = "session.events.unsubscribe";
export const MAX_BODY_BYTES = 12_582_912;
export const MAX_HEADERS = 128;
export const MAX_HEADER_NAME_LENGTH = 256;
export const MAX_HEADER_VALUE_LENGTH = 16_384;
export const FRAME_IDENTIFIER_PATTERN = /^[a-zA-Z0-9-]{1,128}$/u;
export const REQUEST_METHODS = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;
export const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
    "connection",
    "content-length",
    "forwarded",
    "host",
    "origin",
    "upgrade",
    "x-morty-computer-id",
]);

const frameIdentifier = v.pipe(v.string(), v.regex(FRAME_IDENTIFIER_PATTERN));
const headers = v.pipe(
    v.array(
        v.tuple([
            v.pipe(v.string(), v.maxLength(MAX_HEADER_NAME_LENGTH)),
            v.pipe(v.string(), v.maxLength(MAX_HEADER_VALUE_LENGTH)),
        ]),
    ),
    v.maxLength(MAX_HEADERS),
    v.description(
        `Header name and value pairs. Send \`authorization: Bearer <Session credential>\`; ${[...FORBIDDEN_HEADERS].join(", ")}, cf-*, sec-websocket-* and x-forwarded-* are refused.`,
    ),
);
const sessionPath = v.pipe(
    v.string(),
    v.startsWith(`${MORTY_API_PREFIX}/v1/computers/`),
    v.maxLength(8_192),
    v.description("A Session operation path with its query string."),
);

/** Each frame a client sends or receives, named by its `kind`. */
export const transportFrames = {
    httpRequest: {
        direction: "send",
        summary: "Dispatch one Session operation.",
        schema: v.object({
            kind: v.literal(REQUEST_KIND),
            requestId: frameIdentifier,
            method: v.picklist(REQUEST_METHODS),
            path: sessionPath,
            headers,
            body: v.pipe(
                v.string(),
                v.maxLength(MAX_BODY_BYTES),
                v.description("The JSON-encoded encrypted protocol request, including for GET Session operations."),
            ),
        }),
    },
    httpCancel: {
        direction: "send",
        summary: "Abandon a pending http.request; its answer is an http.error unless it already completed.",
        schema: v.object({ kind: v.literal(CANCEL_KIND), requestId: frameIdentifier }),
    },
    httpResponse: {
        direction: "receive",
        summary: "The answer to the http.request with the same requestId.",
        schema: v.object({
            kind: v.literal(RESPONSE_KIND),
            requestId: v.string(),
            status: v.pipe(v.number(), v.integer()),
            headers: v.array(v.tuple([v.string(), v.string()])),
            body: v.pipe(v.string(), v.description("The response body, usually JSON.")),
        }),
    },
    httpError: {
        direction: "receive",
        summary: "A failed request, or a frame the transport could not read.",
        schema: v.object({
            kind: v.literal(ERROR_KIND),
            requestId: v.pipe(v.string(), v.description("`unknown` when the frame could not be read.")),
            status: v.pipe(v.number(), v.integer()),
            code: v.string(),
            message: v.string(),
        }),
    },
    eventsSubscribe: {
        direction: "send",
        summary: "Follow a Session's events live.",
        schema: v.object({
            kind: v.literal(EVENT_SUBSCRIBE_KIND),
            subscriptionId: frameIdentifier,
            path: v.pipe(sessionPath, v.description("The Session's events path.")),
            headers,
        }),
    },
    eventsUnsubscribe: {
        direction: "send",
        summary: "Stop a subscription.",
        schema: v.object({ kind: v.literal(EVENT_UNSUBSCRIBE_KIND), subscriptionId: v.string() }),
    },
    eventsReady: {
        direction: "receive",
        summary: "The subscription is live.",
        schema: v.object({ kind: v.literal("session.events.ready"), subscriptionId: v.string() }),
    },
    eventsEvent: {
        direction: "receive",
        summary: "One live Session event.",
        schema: v.object({
            kind: v.literal("session.events.event"),
            subscriptionId: v.string(),
            seqId: v.pipe(v.number(), v.integer()),
            data: v.pipe(v.string(), v.description("The event, JSON-encoded.")),
        }),
    },
    eventsEnd: {
        direction: "receive",
        summary: "The subscription ended normally.",
        schema: v.object({ kind: v.literal("session.events.end"), subscriptionId: v.string() }),
    },
    eventsError: {
        direction: "receive",
        summary: "The subscription failed; read events and subscribe again.",
        schema: v.object({
            kind: v.literal("session.events.error"),
            subscriptionId: v.string(),
            code: v.string(),
            status: v.optional(v.pipe(v.number(), v.integer())),
            message: v.optional(v.string()),
        }),
    },
    ping: {
        direction: "send",
        summary: "Keep an idle connection open.",
        schema: v.strictObject({ kind: v.literal("ping") }),
    },
    pong: {
        direction: "receive",
        summary: "The answer to ping.",
        schema: v.object({ kind: v.literal("pong") }),
    },
} as const;
