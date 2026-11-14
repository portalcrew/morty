import { z } from "zod";
import { DIRECTORY_PATH as directoryPath } from "../../shared/directory.ts";
import { encryptedMessageCodec } from "../../shared/encrypted-message.ts";
import {
    identifierStringSchema as identifier,
    identifierStringSchema as routingIdentifier,
} from "../../shared/identifier.ts";
import {
    decodeZodMessage as decodeRoutingZodMessage,
    encryptedFieldSchema,
    ProtocolMessageError,
} from "../../shared/message-codec.ts";
import { decodeKnownNativeSessionEvents, nativeSessionEventsSchema } from "../events/index.ts";
import {
    nativeSessionTargetSchema,
    nativeSessionTargetSchema as routingTarget,
} from "../shared/native-session-target.ts";

export const SESSION_HISTORY_PAGE_LOAD_KIND = "session.live-history.v2.page.load";
export const SESSION_HISTORY_PAGE_LOADED_KIND = "session.live-history.v2.page.loaded";
export const SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND = "session.preview-history.page.load";
export const SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND = "session.preview-history.page.loaded";

const pageRequestFields = {
    cursor: z.string().min(1).max(512).nullable(),
    eventLimit: z.number().int().min(1).max(10_000),
    requestId: identifier,
    target: nativeSessionTargetSchema,
};

const sessionHistoryPageLoadSchema = z
    .object({ ...pageRequestFields, kind: z.literal(SESSION_HISTORY_PAGE_LOAD_KIND) })
    .readonly();

// The Agent's own history on disk, read from the directory the caller browses; the target names its Agent.
const sessionPreviewHistoryPageLoadSchema = z
    .object({
        ...pageRequestFields,
        directory: directoryPath,
        kind: z.literal(SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND),
    })
    .readonly();

const pageLoadedFields = {
    events: nativeSessionEventsSchema,
    requestId: identifier,
    target: nativeSessionTargetSchema,
};

const sessionHistoryPageLoadedSchema = z
    .object({ ...pageLoadedFields, kind: z.literal(SESSION_HISTORY_PAGE_LOADED_KIND) })
    .readonly();

const sessionPreviewHistoryPageLoadedSchema = z
    .object({ ...pageLoadedFields, kind: z.literal(SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND) })
    .readonly();

export type SessionHistoryPageLoad = z.infer<typeof sessionHistoryPageLoadSchema>;
export type SessionHistoryPageLoaded = z.infer<typeof sessionHistoryPageLoadedSchema>;
export type SessionPreviewHistoryPageLoad = z.infer<typeof sessionPreviewHistoryPageLoadSchema>;
export type SessionPreviewHistoryPageLoaded = z.infer<typeof sessionPreviewHistoryPageLoadedSchema>;

function decode<T>(schema: z.ZodType<T>, encoded: string): T {
    try {
        const value: unknown = JSON.parse(encoded);
        return schema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid live Session history message", { cause });
    }
}

function decodeLoaded<T>(schema: z.ZodType<T>, encoded: string): T {
    try {
        const value: unknown = JSON.parse(encoded);
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            return schema.parse(value);
        }
        return schema.parse({ ...value, events: decodeKnownNativeSessionEvents(Reflect.get(value, "events")) });
    } catch (cause) {
        throw new ProtocolMessageError("Invalid live Session history message", { cause });
    }
}

const decodeSessionHistoryPageLoad = (encoded: string): SessionHistoryPageLoad =>
    decode(sessionHistoryPageLoadSchema, encoded);
export const decodeSessionHistoryPageLoaded = (encoded: string): SessionHistoryPageLoaded =>
    decodeLoaded(sessionHistoryPageLoadedSchema, encoded);
const decodeSessionPreviewHistoryPageLoad = (encoded: string): SessionPreviewHistoryPageLoad =>
    decode(sessionPreviewHistoryPageLoadSchema, encoded);
export const decodeSessionPreviewHistoryPageLoaded = (encoded: string): SessionPreviewHistoryPageLoaded =>
    decodeLoaded(sessionPreviewHistoryPageLoadedSchema, encoded);
export const encodeSessionHistoryPageLoad = (value: SessionHistoryPageLoad): string =>
    JSON.stringify(sessionHistoryPageLoadSchema.parse(value));
export const encodeSessionPreviewHistoryPageLoad = (value: SessionPreviewHistoryPageLoad): string =>
    JSON.stringify(sessionPreviewHistoryPageLoadSchema.parse(value));

const sessionPreviewHistoryPageLoadPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionPreviewHistoryPageLoadRoutingSchema = sessionPreviewHistoryPageLoadPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionPreviewHistoryPageLoadRouting = z.infer<typeof sessionPreviewHistoryPageLoadRoutingSchema>;
const decodeSessionPreviewHistoryPageLoadRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionPreviewHistoryPageLoadRoutingSchema);
export const sessionPreviewHistoryPageLoadCodec = encryptedMessageCodec({
    kind: SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    decode: decodeSessionPreviewHistoryPageLoad,
    decodeRouting: decodeSessionPreviewHistoryPageLoadRouting,
    publicRoutingSchema: sessionPreviewHistoryPageLoadPublicRoutingSchema,
});

const sessionHistoryPageLoadPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_HISTORY_PAGE_LOAD_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionHistoryPageLoadRoutingSchema = sessionHistoryPageLoadPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionHistoryPageLoadRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionHistoryPageLoadRoutingSchema);
export const sessionHistoryPageLoadCodec = encryptedMessageCodec({
    kind: SESSION_HISTORY_PAGE_LOAD_KIND,
    decode: decodeSessionHistoryPageLoad,
    decodeRouting: decodeSessionHistoryPageLoadRouting,
    publicRoutingSchema: sessionHistoryPageLoadPublicRoutingSchema,
});

const sessionPreviewHistoryPageLoadedPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionPreviewHistoryPageLoadedRoutingSchema = sessionPreviewHistoryPageLoadedPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionPreviewHistoryPageLoadedRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionPreviewHistoryPageLoadedRoutingSchema);
export const sessionPreviewHistoryPageLoadedCodec = encryptedMessageCodec({
    kind: SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
    decode: decodeSessionPreviewHistoryPageLoaded,
    decodeRouting: decodeSessionPreviewHistoryPageLoadedRouting,
    publicRoutingSchema: sessionPreviewHistoryPageLoadedPublicRoutingSchema,
});

const sessionHistoryPageLoadedPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_HISTORY_PAGE_LOADED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionHistoryPageLoadedRoutingSchema = sessionHistoryPageLoadedPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export function historyWireJsonSchemas() {
    return {
        historyRequest: z.toJSONSchema(sessionHistoryPageLoadRoutingSchema),
        historyReply: z.toJSONSchema(sessionHistoryPageLoadedRoutingSchema),
    };
}
const decodeSessionHistoryPageLoadedRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionHistoryPageLoadedRoutingSchema);
export const sessionHistoryPageLoadedCodec = encryptedMessageCodec({
    kind: SESSION_HISTORY_PAGE_LOADED_KIND,
    decode: decodeSessionHistoryPageLoaded,
    decodeRouting: decodeSessionHistoryPageLoadedRouting,
    publicRoutingSchema: sessionHistoryPageLoadedPublicRoutingSchema,
});
