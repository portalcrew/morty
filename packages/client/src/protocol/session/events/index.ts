import { z } from "zod";
import { DIRECTORY_PATH } from "../../shared/directory.ts";
import { encryptedMessageCodec } from "../../shared/encrypted-message.ts";
import { identifierStringSchema as identifier } from "../../shared/identifier.ts";
import {
    decodeZodMessage as decodeRoutingZodMessage,
    encryptedFieldSchema,
    ProtocolMessageError,
} from "../../shared/message-codec.ts";
import { boundedJsonSchema, toolCallLocationSchema } from "../../shared/tool-input.ts";
import {
    sessionElicitationRequestedEventSchema,
    sessionElicitationResolvedEventSchema,
    sessionPermissionRequestedEventSchema,
    sessionPermissionResolvedEventSchema,
} from "../interactions/index.ts";
import { nativeSessionTargetSchema } from "../shared/native-session-target.ts";

const MAX_EVENT_COUNT = 10_000;
const MAX_COLLECTION_SIZE = 1_000;
const MAX_CONTENT_LENGTH = 1_000_000;
export const SESSION_EVENT_KIND = "session.event.v2";
export const SESSION_EVENTS_SUBSCRIBE_KIND = "session.events.subscribe";
export const SESSION_EVENTS_UNSUBSCRIBE_KIND = "session.events.unsubscribe";
export const SESSION_EVENT_BATCH_MAX_SIZE = 1_000;

const boundedString = z.string().max(MAX_CONTENT_LENGTH);
const shortString = z.string().max(2_048);
const externalContentKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);

const annotationsSchema = z
    .object({
        audience: z
            .array(z.enum(["assistant", "user"]))
            .max(2)
            .readonly()
            .nullable()
            .optional(),
        lastModified: shortString.nullable().optional(),
        priority: z.number().finite().nullable().optional(),
    })
    .readonly();
const contentFields = { annotations: annotationsSchema.nullable().optional() };
const textContentSchema = z.object({ ...contentFields, text: boundedString, type: z.literal("text") }).readonly();
const imageContentSchema = z
    .object({
        ...contentFields,
        data: z.string(),
        mimeType: shortString,
        type: z.literal("image"),
        uri: boundedString.nullable().optional(),
    })
    .readonly();
const audioContentSchema = z
    .object({ ...contentFields, data: z.string(), mimeType: shortString, type: z.literal("audio") })
    .readonly();
const externalImageContentSchema = z
    .object({
        ...contentFields,
        byteLength: z.number().int().positive().safe(),
        imageKey: externalContentKeySchema,
        mimeType: shortString,
        type: z.literal("external_image"),
        uri: boundedString.nullable().optional(),
    })
    .readonly();
const externalAudioContentSchema = z
    .object({
        ...contentFields,
        audioKey: externalContentKeySchema,
        byteLength: z.number().int().positive().safe(),
        mimeType: shortString,
        type: z.literal("external_audio"),
    })
    .readonly();
const externalResourceContentSchema = z
    .object({
        ...contentFields,
        byteLength: z.number().int().positive().safe(),
        encoding: z.enum(["binary", "text"]),
        mimeType: shortString.nullable().optional(),
        resourceKey: externalContentKeySchema,
        type: z.literal("external_resource"),
        uri: boundedString,
    })
    .readonly();
const resourceLinkSchema = z
    .object({
        ...contentFields,
        description: boundedString.nullable().optional(),
        mimeType: shortString.nullable().optional(),
        name: shortString,
        size: z.number().int().nonnegative().safe().nullable().optional(),
        title: shortString.nullable().optional(),
        type: z.literal("resource_link"),
        uri: boundedString,
    })
    .readonly();
const textResourceSchema = z
    .object({
        mimeType: shortString.nullable().optional(),
        text: boundedString,
        uri: boundedString,
    })
    .readonly();
const blobResourceSchema = z
    .object({
        blob: z.string(),
        mimeType: shortString.nullable().optional(),
        uri: boundedString,
    })
    .readonly();
const embeddedResourceSchema = z
    .object({
        ...contentFields,
        resource: z.union([textResourceSchema, blobResourceSchema]),
        type: z.literal("resource"),
    })
    .readonly();

const contentBlockSchema = z.discriminatedUnion("type", [
    textContentSchema,
    imageContentSchema,
    audioContentSchema,
    resourceLinkSchema,
    embeddedResourceSchema,
    externalImageContentSchema,
    externalAudioContentSchema,
    externalResourceContentSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ExternalImageContentBlock = z.infer<typeof externalImageContentSchema>;
export type ExternalAudioContentBlock = z.infer<typeof externalAudioContentSchema>;
export type ExternalResourceContentBlock = z.infer<typeof externalResourceContentSchema>;

const toolCallContentSchema = z.discriminatedUnion("type", [
    z.object({ content: contentBlockSchema, type: z.literal("content") }).readonly(),
    z
        .object({
            newText: boundedString,
            oldText: boundedString.nullable().optional(),
            path: boundedString,
            type: z.literal("diff"),
        })
        .readonly(),
    z.object({ terminalId: shortString, type: z.literal("terminal") }).readonly(),
]);
const toolKindSchema = z.enum([
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
]);
const toolStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);
const backgroundTaskSchema = z
    .object({
        id: shortString,
        status: z.enum(["running", "completed", "failed", "stopped", "unknown"]),
    })
    .readonly();
const toolPatchFields = {
    backgroundTask: backgroundTaskSchema.optional(),
    content: z.array(toolCallContentSchema).max(MAX_COLLECTION_SIZE).readonly().nullable().optional(),
    kind: toolKindSchema.nullable().optional(),
    locations: z.array(toolCallLocationSchema).max(MAX_COLLECTION_SIZE).readonly().nullable().optional(),
    name: shortString.nullable().optional(),
    rawInput: boundedJsonSchema.optional(),
    rawOutput: boundedJsonSchema.optional(),
    status: toolStatusSchema.nullable().optional(),
    title: boundedString.nullable().optional(),
};
const planEntrySchema = z
    .object({
        content: boundedString,
        priority: z.enum(["high", "medium", "low"]),
        status: z.enum(["pending", "in_progress", "completed"]),
    })
    .readonly();
const commandSchema = z
    .object({
        description: boundedString,
        input: z.object({ hint: boundedString }).readonly().nullable().optional(),
        name: shortString,
    })
    .readonly();
const configSelectOptionSchema = z
    .object({
        description: boundedString.nullable().optional(),
        name: shortString,
        value: shortString,
    })
    .readonly();
const configSelectGroupSchema = z
    .object({
        group: shortString,
        name: shortString,
        options: z.array(configSelectOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
    })
    .readonly();
const configBaseFields = {
    category: shortString.nullable().optional(),
    description: boundedString.nullable().optional(),
    id: shortString,
    name: shortString,
};
const sessionConfigOptionSchema = z.discriminatedUnion("type", [
    z
        .object({
            ...configBaseFields,
            currentValue: shortString,
            options: z.union([
                z.array(configSelectOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
                z.array(configSelectGroupSchema).max(MAX_COLLECTION_SIZE).readonly(),
            ]),
            type: z.literal("select"),
        })
        .readonly(),
    z.object({ ...configBaseFields, currentValue: z.boolean(), type: z.literal("boolean") }).readonly(),
]);
const contentChunkFields = {
    content: contentBlockSchema,
    messageId: shortString.min(1),
};
/**
 * A question an Agent message asks while the Agent keeps working, with the answers it suggests (none for a free-text
 * question). The message text already states it; the user answers with an ordinary message.
 */
const agentQuestionSchema = z
    .object({
        options: z.array(shortString).max(MAX_COLLECTION_SIZE).readonly(),
        question: boundedString,
    })
    .readonly();
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;

const acpSessionUpdateSchema = z.discriminatedUnion("sessionUpdate", [
    z.object({ ...contentChunkFields, sessionUpdate: z.literal("user_message_chunk") }).readonly(),
    z
        .object({
            ...contentChunkFields,
            questions: z.array(agentQuestionSchema).min(1).max(MAX_COLLECTION_SIZE).readonly().optional(),
            sessionUpdate: z.literal("agent_message_chunk"),
        })
        .readonly(),
    z
        .object({
            ...contentChunkFields,
            meta: z.object({ truncated: z.boolean().optional() }).readonly().optional(),
            sessionUpdate: z.literal("agent_thought_chunk"),
        })
        .readonly(),
    z
        .object({
            backgroundTask: backgroundTaskSchema.optional(),
            content: z.array(toolCallContentSchema).max(MAX_COLLECTION_SIZE).readonly().optional(),
            kind: toolKindSchema.optional(),
            locations: z.array(toolCallLocationSchema).max(MAX_COLLECTION_SIZE).readonly().optional(),
            name: shortString.nullable().optional(),
            rawInput: boundedJsonSchema.optional(),
            rawOutput: boundedJsonSchema.optional(),
            sessionUpdate: z.literal("tool_call"),
            status: toolStatusSchema.optional(),
            title: boundedString,
            toolCallId: shortString,
        })
        .readonly(),
    z.object({ ...toolPatchFields, sessionUpdate: z.literal("tool_call_update"), toolCallId: shortString }).readonly(),
    z
        .object({
            entries: z.array(planEntrySchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("plan"),
        })
        .readonly(),
    z
        .object({
            availableCommands: z.array(commandSchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("available_commands_update"),
        })
        .readonly(),
    z
        .object({
            currentModeId: shortString,
            sessionUpdate: z.literal("current_mode_update"),
        })
        .readonly(),
    z
        .object({
            configOptions: z.array(sessionConfigOptionSchema).max(MAX_COLLECTION_SIZE).readonly(),
            sessionUpdate: z.literal("config_option_update"),
        })
        .readonly(),
    z
        .object({
            sessionUpdate: z.literal("session_info_update"),
            title: boundedString.nullable().optional(),
            updatedAt: shortString.nullable().optional(),
        })
        .readonly(),
    z
        .object({
            cost: z
                .object({ amount: z.number().finite(), currency: z.string().max(16) })
                .readonly()
                .nullable()
                .optional(),
            sessionUpdate: z.literal("usage_update"),
            size: z.number().int().nonnegative().safe(),
            used: z.number().int().nonnegative().safe(),
        })
        .readonly(),
    z
        .object({
            compactionId: shortString,
            error: boundedString.nullable().optional(),
            sessionUpdate: z.literal("compaction_update"),
            status: shortString,
            summary: z.array(contentBlockSchema).max(MAX_COLLECTION_SIZE).readonly().nullable().optional(),
        })
        .readonly(),
    z
        .object({
            compactionId: shortString,
            content: contentBlockSchema,
            sessionUpdate: z.literal("compaction_summary_chunk"),
        })
        .readonly(),
]);
export type AcpSessionUpdate = z.infer<typeof acpSessionUpdateSchema>;

const lifecycleBase = { commandId: identifier };
/** How an admitted prompt executes: as its own turn, or by steering the running turn of `targetCommandId`. */
const promptDispatchSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("own") }).readonly(),
    z.object({ kind: z.literal("steer"), targetCommandId: identifier }).readonly(),
]);
export type PromptDispatch = z.infer<typeof promptDispatchSchema>;
// The user message the Agent recorded for the prompt, as its message identity. Agents that report none, and Computers
// before it existed, omit it.
const promptMessageId = z.string().min(1).max(2_048);
export interface PromptExecutionContext {
    readonly harness: string;
    readonly directory: string;
}
const promptExecutionContextSchema = z
    .object({
        harness: identifier,
        directory: DIRECTORY_PATH,
    })
    .readonly() satisfies z.ZodType<PromptExecutionContext>;

/**
 * How a completed prompt ended: the Agent stopped it for `stopReason`, it was cancelled (`started` says whether its
 * execution ever began, so a prompt withdrawn from the queue is told from one stopped mid-turn), or it was folded into
 * the running turn it steered.
 */
const promptCompletionSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ended"), stopReason: shortString }).readonly(),
    z.object({ kind: z.literal("cancelled"), started: z.boolean() }).readonly(),
    z.object({ kind: z.literal("steered") }).readonly(),
]);
export type PromptCompletion = z.infer<typeof promptCompletionSchema>;
const promptCompletedSchema = z
    .object({
        ...lifecycleBase,
        completion: promptCompletionSchema,
        kind: z.literal("prompt.completed"),
        messageId: promptMessageId.optional(),
    })
    .readonly();
const promptFailedSchema = z
    .object({
        ...lifecycleBase,
        attemptId: identifier,
        code: identifier,
        kind: z.literal("prompt.failed"),
        message: z.string().min(1).max(500),
        messageId: promptMessageId.optional(),
    })
    .readonly();
const lifecycleMetadataSchema = z.discriminatedUnion("kind", [
    // `changedByCommandId` names the command whose admission to or departure from the queue changed it. Computers
    // before it existed omit it, so a reader must treat an unnamed change as possibly any command's.
    z.object({ changedByCommandId: identifier.optional(), kind: z.literal("session.queue.changed") }).readonly(),
    z
        .object({ event: sessionPermissionRequestedEventSchema, kind: z.literal("session.permission.requested") })
        .readonly(),
    z
        .object({ event: sessionPermissionResolvedEventSchema, kind: z.literal("session.permission.resolved") })
        .readonly(),
    z
        .object({ event: sessionElicitationRequestedEventSchema, kind: z.literal("session.elicitation.requested") })
        .readonly(),
    z
        .object({ event: sessionElicitationResolvedEventSchema, kind: z.literal("session.elicitation.resolved") })
        .readonly(),
    z
        .object({
            ...lifecycleBase,
            content: z.array(contentBlockSchema).min(1).max(100).readonly(),
            dispatch: promptDispatchSchema,
            kind: z.literal("prompt.requested"),
            context: promptExecutionContextSchema.optional(),
        })
        .readonly(),
    z.object({ ...lifecycleBase, attemptId: identifier, kind: z.literal("prompt.started") }).readonly(),
    // The Computer did not run this prompt itself: it handed it to the native session's owner, another client of the
    // Agent such as the Codex app, which runs queued input on its own terms. `queued`: the owner holds the prompt and
    // may keep holding it; Codex pauses its queue after an interrupted turn until its user continues. `started`: the
    // owner began running it, so only the owner can stop it and cancelling it here leaves it running. Computers before
    // this event never delegate.
    z
        .object({ ...lifecycleBase, kind: z.literal("prompt.delegated"), stage: z.enum(["queued", "started"]) })
        .readonly(),
    promptCompletedSchema,
    z
        .object({
            ...lifecycleBase,
            code: identifier,
            kind: z.literal("prompt.failed-before-start"),
            message: z.string().min(1).max(500),
        })
        .readonly(),
    promptFailedSchema,
]);
export type LifecycleMetadata = z.infer<typeof lifecycleMetadataSchema>;
/** A lifecycle event that settles its prompt command: no later lifecycle event of that command follows it. */
export type PromptTerminalLifecycle = Extract<
    LifecycleMetadata,
    { readonly kind: "prompt.completed" | "prompt.failed" | "prompt.failed-before-start" }
>;
export const isPromptTerminal = (payload: LifecycleMetadata): payload is PromptTerminalLifecycle => {
    switch (payload.kind) {
        case "prompt.completed":
        case "prompt.failed":
        case "prompt.failed-before-start":
            return true;
        case "prompt.requested":
        case "prompt.started":
        case "prompt.delegated":
        case "session.queue.changed":
        case "session.permission.requested":
        case "session.permission.resolved":
        case "session.elicitation.requested":
        case "session.elicitation.resolved":
            return false;
        default: {
            // Every lifecycle kind must decide whether it settles its command.
            const unknownKind: never = payload;
            void unknownKind;
            return false;
        }
    }
};

/** The ACP stop reason a settled command's reply reports for how its prompt ended. */
export const promptStopReason = (completion: PromptCompletion): string => {
    switch (completion.kind) {
        case "ended":
            return completion.stopReason;
        case "cancelled":
            return "cancelled";
        case "steered":
            return "steered";
        default:
            return completion satisfies never;
    }
};
const sessionEventPayloadSchema = z.discriminatedUnion("type", [
    z.object({ payload: acpSessionUpdateSchema, type: z.literal("acp") }).readonly(),
    z.object({ payload: lifecycleMetadataSchema, type: z.literal("lifecycle-metadata") }).readonly(),
]);
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>;
const positionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
/**
 * `restated` marks a lifecycle event that restates an outcome the Computer already recorded for its command, answering a
 * retried request about that command or republishing it after a restart. It is not a new fact: it reaches clients and
 * the request it answers, but never status notifications.
 */
const mortyMetadataFields = {
    omitted: z.literal(true).optional(),
    restated: z.literal(true).optional(),
};
const sharedSessionEventFields = {
    eventId: identifier,
    mortyMetadata: z.object(mortyMetadataFields).readonly().optional(),
    recordedAt: z.iso.datetime({ offset: true }),
};
// A live event is read on its own, so it names the Session generation and position it belongs to. A history page
// states its Session and generation once, so its events do not repeat them.
const sessionLiveEventFields = {
    ...sharedSessionEventFields,
    position: positionSchema,
    sessionGenerationId: identifier,
    target: nativeSessionTargetSchema,
};
/**
 * A Session history entry: the Agent's events, and the lifecycle of each turn the Computer ran, in the order they
 * happened. A history page is read in the same order as the live stream, so its reader needs no other record to tell
 * which command a message belongs to or where its turn ended.
 */
const sessionEventSchema = z.discriminatedUnion("type", [
    z.object({ ...sharedSessionEventFields, payload: acpSessionUpdateSchema, type: z.literal("acp") }).readonly(),
    z
        .object({
            ...sharedSessionEventFields,
            payload: lifecycleMetadataSchema,
            type: z.literal("lifecycle-metadata"),
        })
        .readonly(),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
const sessionLiveEventSchema = z.discriminatedUnion("type", [
    z.object({ ...sessionLiveEventFields, payload: acpSessionUpdateSchema, type: z.literal("acp") }).readonly(),
    z
        .object({
            ...sessionLiveEventFields,
            payload: lifecycleMetadataSchema,
            type: z.literal("lifecycle-metadata"),
        })
        .readonly(),
]);
export type SessionLiveEvent = z.infer<typeof sessionLiveEventSchema>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const sessionLiveEventBatchSchema = z.array(sessionLiveEventSchema).min(1).max(SESSION_EVENT_BATCH_MAX_SIZE).readonly();
export type SessionLiveEventBatch = z.infer<typeof sessionLiveEventBatchSchema>;
const sessionEventEnvelopeSchema = z
    .object({ events: sessionLiveEventBatchSchema, kind: z.literal(SESSION_EVENT_KIND) })
    .readonly();
export type SessionEventEnvelope = z.infer<typeof sessionEventEnvelopeSchema>;
const sessionEventLogPageSchema = z
    .object({
        events: z.array(sessionEventSchema).max(MAX_EVENT_COUNT).readonly(),
        nextCursor: z.string().min(1).max(512).nullable(),
        sessionGenerationId: identifier,
        // The generation-scoped live position covered by this snapshot, including
        // coalesced and omitted events.
        throughPosition: positionSchema,
    })
    .readonly();
export type SessionEventLogPage = z.infer<typeof sessionEventLogPageSchema>;
export const nativeSessionEventsSchema = z.object({ events: sessionEventLogPageSchema }).readonly();
export type NativeSessionEvents = z.infer<typeof nativeSessionEventsSchema>;

function inputValue(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed;
    } catch (cause) {
        throw new ProtocolMessageError("Session Event Log V2 message is not valid JSON", { cause });
    }
}
function decode<T>(value: unknown, schema: z.ZodType<T>): T {
    const result = schema.safeParse(inputValue(value));
    if (!result.success) {
        throw new ProtocolMessageError("Session Event Log V2 message does not match its schema", {
            cause: result.error,
        });
    }
    return result.data;
}
function decodedEntries<T>(value: unknown, schema: z.ZodType<T>, maximum: number): unknown {
    return Array.isArray(value) && value.length <= maximum
        ? value.flatMap((entry) => {
              const decoded = schema.safeParse(entry);
              return decoded.success ? [decoded.data] : [];
          })
        : value;
}
function sanitizeConsumableNativeSessionEvents(value: unknown): unknown {
    const input = inputValue(value);
    if (!isRecord(input)) {
        return input;
    }
    return { ...input, events: sanitizeConsumableSessionEventLogPage(input["events"]) };
}
function sanitizeConsumableSessionEventLogPage(value: unknown): unknown {
    const input = inputValue(value);
    return isRecord(input)
        ? {
              ...input,
              events: decodedEntries(input["events"], sessionEventSchema, MAX_EVENT_COUNT),
          }
        : input;
}
const knownSessionLiveEventBatchSchema = z.array(sessionLiveEventSchema).max(SESSION_EVENT_BATCH_MAX_SIZE).readonly();
export const decodeSessionEvent = (value: unknown): SessionEvent => decode(value, sessionEventSchema);
export const decodeKnownSessionEventPayload = (value: unknown): SessionEventPayload | null => {
    const decoded = sessionEventPayloadSchema.safeParse(inputValue(value));
    return decoded.success ? decoded.data : null;
};
export const decodeSessionLiveEvent = (value: unknown): SessionLiveEvent => decode(value, sessionLiveEventSchema);
export const decodeKnownSessionLiveEventBatch = (value: unknown): SessionLiveEventBatch =>
    decode(
        decodedEntries(inputValue(value), sessionLiveEventSchema, SESSION_EVENT_BATCH_MAX_SIZE),
        knownSessionLiveEventBatchSchema,
    );
export const decodeSessionEventEnvelope = (value: unknown): SessionEventEnvelope =>
    decode(value, sessionEventEnvelopeSchema);
function eventBatchTarget(message: SessionEventEnvelope): z.infer<typeof nativeSessionTargetSchema> {
    const first = message.events[0];
    if (first === undefined) {
        throw new ProtocolMessageError("Session event batch must not be empty");
    }
    const target = first.target;
    if (
        message.events.some(
            (event) => event.target.harness !== target.harness || event.target.sessionId !== target.sessionId,
        )
    ) {
        throw new ProtocolMessageError("Session event batch must have one target");
    }
    return target;
}
export const encodeSessionEventEnvelope = (value: SessionEventEnvelope): string => {
    const message = decodeSessionEventEnvelope(value);
    return JSON.stringify({ ...message, target: eventBatchTarget(message) });
};
export const decodeAcpSessionUpdate = (value: unknown): AcpSessionUpdate => decode(value, acpSessionUpdateSchema);
export const decodeKnownSessionEventLogPage = (value: unknown): SessionEventLogPage =>
    decode(sanitizeConsumableSessionEventLogPage(value), sessionEventLogPageSchema);
export const decodeNativeSessionEvents = (value: unknown): NativeSessionEvents =>
    decode(value, nativeSessionEventsSchema);
export const decodeKnownNativeSessionEvents = (value: unknown): NativeSessionEvents =>
    decode(sanitizeConsumableNativeSessionEvents(value), nativeSessionEventsSchema);

const sessionEventEnvelopePublicRoutingSchema = z.object({
    kind: z.literal(SESSION_EVENT_KIND),
    target: nativeSessionTargetSchema,
});
const sessionEventEnvelopeRoutingSchema = sessionEventEnvelopePublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionEventEnvelopeRouting = z.infer<typeof sessionEventEnvelopeRoutingSchema>;
const decodeSessionEventEnvelopeRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionEventEnvelopeRoutingSchema);
function decodeRoutedSessionEventEnvelope(encoded: string) {
    const value = inputValue(encoded);
    if (!isRecord(value)) {
        throw new ProtocolMessageError("Session event message must be an object");
    }
    const message = decodeSessionEventEnvelope(value);
    const target = decode(value["target"], nativeSessionTargetSchema);
    const actual = eventBatchTarget(message);
    if (actual.harness !== target.harness || actual.sessionId !== target.sessionId) {
        throw new ProtocolMessageError("Session event batch target does not match its route");
    }
    return { ...message, target };
}

const encryptedSessionEventEnvelopeCodec = encryptedMessageCodec({
    kind: SESSION_EVENT_KIND,
    decode: decodeRoutedSessionEventEnvelope,
    decodeRouting: decodeSessionEventEnvelopeRouting,
    publicRoutingSchema: sessionEventEnvelopePublicRoutingSchema,
});
export const sessionEventEnvelopeCodec = Object.freeze({
    kind: SESSION_EVENT_KIND,
    decodeRouting: decodeSessionEventEnvelopeRouting,
    encodeRouting: (message: SessionEventEnvelopeRouting): string =>
        JSON.stringify(decodeSessionEventEnvelopeRouting(JSON.stringify(message))),
    encode: async (
        value: unknown,
        encryptor: Parameters<typeof encryptedSessionEventEnvelopeCodec.encode>[1],
        signal: AbortSignal,
    ): Promise<string> => {
        const message = decodeSessionEventEnvelope(value);
        return encryptedSessionEventEnvelopeCodec.encode(
            { ...message, target: eventBatchTarget(message) },
            encryptor,
            signal,
        );
    },
    decode: async (
        encoded: string,
        decryptor: Parameters<typeof encryptedSessionEventEnvelopeCodec.decode>[1],
        signal: AbortSignal,
    ): Promise<SessionEventEnvelope> => {
        const { target: _target, ...message } = await encryptedSessionEventEnvelopeCodec.decode(
            encoded,
            decryptor,
            signal,
        );
        return message;
    },
});

const sessionEventsSubscribeSchema = z
    .strictObject({
        kind: z.literal(SESSION_EVENTS_SUBSCRIBE_KIND),
        subscriptionId: identifier,
        target: nativeSessionTargetSchema,
    })
    .readonly();
const sessionEventsUnsubscribeSchema = z
    .strictObject({
        kind: z.literal(SESSION_EVENTS_UNSUBSCRIBE_KIND),
        subscriptionId: identifier,
        target: nativeSessionTargetSchema,
    })
    .readonly();
export type SessionEventsSubscribeCommand = z.infer<typeof sessionEventsSubscribeSchema>;
type SessionEventsUnsubscribe = z.infer<typeof sessionEventsUnsubscribeSchema>;
export type SessionEventsUnsubscribeControl = SessionEventsUnsubscribe;

const decodeSessionEventsSubscribeCommand = (encoded: string): SessionEventsSubscribeCommand =>
    decode(encoded, sessionEventsSubscribeSchema);
export const decodeSessionEventsUnsubscribe = (encoded: string): SessionEventsUnsubscribe =>
    decode(encoded, sessionEventsUnsubscribeSchema);
export const encodeSessionEventsUnsubscribe = (message: SessionEventsUnsubscribe): string =>
    JSON.stringify(decodeSessionEventsUnsubscribe(JSON.stringify(message)));

const sessionEventsSubscribeRoutingSchema = sessionEventsSubscribeSchema
    .unwrap()
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionEventsSubscribeCommandRouting = z.infer<typeof sessionEventsSubscribeRoutingSchema>;

export const sessionEventsSubscribeCommandCodec = encryptedMessageCodec({
    kind: SESSION_EVENTS_SUBSCRIBE_KIND,
    decode: decodeSessionEventsSubscribeCommand,
    decodeRouting: (encoded: string): SessionEventsSubscribeCommandRouting =>
        decodeRoutingZodMessage(encoded, sessionEventsSubscribeRoutingSchema),
    publicRoutingSchema: sessionEventsSubscribeSchema.unwrap(),
});
