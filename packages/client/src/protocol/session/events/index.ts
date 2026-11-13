import { z } from "zod";
import { DIRECTORY_PATH } from "../../shared/directory.ts";
import { identifierStringSchema as identifier } from "../../shared/identifier.ts";
import { ProtocolMessageError } from "../../shared/message-codec.ts";
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

const promptCompletedSchema = z
    .object({
        ...lifecycleBase,
        kind: z.literal("prompt.completed"),
        execution: z.literal("not-started").optional(),
        messageId: promptMessageId.optional(),
        stopReason: shortString,
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
            disposition: shortString.optional(),
            kind: z.literal("prompt.requested"),
            context: promptExecutionContextSchema.optional(),
            targetCommandId: identifier.optional(),
        })
        .readonly(),
    z
        .object({ ...lifecycleBase, attemptId: identifier, epoch: identifier, kind: z.literal("prompt.started") })
        .readonly(),
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

/**
 * How a completed prompt ended. Agents report a cancelled prompt with the ACP stop reason `cancelled`, the Computer
 * reports a prompt folded into another one as `steered`, and `execution` marks a prompt withdrawn before it started.
 * Readers classify a completion here instead of comparing stop reasons themselves.
 */
export type PromptCompletion =
    | { readonly kind: "cancelled"; readonly started: boolean }
    | { readonly kind: "steered" }
    | { readonly kind: "ended"; readonly stopReason: string };

export const promptCompletion = (completed: {
    readonly stopReason: string;
    readonly execution?: "not-started" | undefined;
}): PromptCompletion => {
    switch (completed.stopReason) {
        case "cancelled":
            return { kind: "cancelled", started: completed.execution !== "not-started" };
        case "steered":
            return { kind: "steered" };
        default:
            return { kind: "ended", stopReason: completed.stopReason };
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
    sessionGenerationId: identifier,
    target: nativeSessionTargetSchema,
};
const sessionLiveEventFields = { ...sharedSessionEventFields, position: positionSchema };
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

// Forwarders own routing and archive identity, not the independently versioned content model.
// Keep opaque payload fields intact; consumers must still validate content before interpreting it.
const wireLifecyclePayloadSchema = z
    .object({
        kind: identifier,
        commandId: identifier.optional(),
        context: promptExecutionContextSchema.unwrap().passthrough().readonly().optional(),
        event: z.object({ interactionId: identifier.optional() }).passthrough().readonly().optional(),
    })
    .passthrough()
    .readonly();
const wireEventFields = {
    ...sessionLiveEventFields,
    mortyMetadata: z.object(mortyMetadataFields).passthrough().readonly().optional(),
};
const sessionWireEventSchema = z.union([
    z
        .object({
            ...wireEventFields,
            type: z.literal("acp"),
            payload: z.object({ sessionUpdate: identifier }).passthrough().readonly(),
        })
        .passthrough()
        .readonly(),
    z
        .object({
            ...wireEventFields,
            type: z.literal("lifecycle-metadata"),
            payload: wireLifecyclePayloadSchema,
        })
        .passthrough()
        .readonly(),
    z
        .object({
            ...wireEventFields,
            type: identifier.refine((type) => type !== "acp" && type !== "lifecycle-metadata"),
            payload: z.record(z.string(), z.unknown()).readonly(),
        })
        .passthrough()
        .readonly(),
]);
const sessionWireEnvelopeSchema = z
    .object({
        kind: z.literal(SESSION_EVENT_KIND),
        events: z.array(sessionWireEventSchema).min(1).max(SESSION_EVENT_BATCH_MAX_SIZE).readonly(),
    })
    .passthrough()
    .readonly();
export type SessionWireEnvelope = z.infer<typeof sessionWireEnvelopeSchema>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const sessionLiveEventBatchSchema = z.array(sessionLiveEventSchema).min(1).max(SESSION_EVENT_BATCH_MAX_SIZE).readonly();
export type SessionLiveEventBatch = z.infer<typeof sessionLiveEventBatchSchema>;
const sessionEventEnvelopeSchema = z
    .object({ events: sessionLiveEventBatchSchema, kind: z.literal(SESSION_EVENT_KIND) })
    .readonly();
export type SessionEventEnvelope = z.infer<typeof sessionEventEnvelopeSchema>;
export const sessionEventLogPageSchema = z
    .object({
        events: z.array(sessionEventSchema).max(MAX_EVENT_COUNT).readonly(),
        nextCursor: z.string().min(1).max(512).nullable(),
        sessionGenerationId: identifier,
        tailCursor: z.string().max(512),
        // The generation-scoped live position covered by this snapshot, including
        // coalesced and omitted events.
        throughPosition: positionSchema,
        truncated: z.boolean(),
        version: z.literal(2),
    })
    .readonly();
export type SessionEventLogPage = z.infer<typeof sessionEventLogPageSchema>;
const nativeEventPageRequestSchema = z
    .object({
        cursor: z.string().min(1).max(512).nullable(),
        eventLimit: z.number().int().min(1).max(10_000),
    })
    .readonly();
export type NativeEventPageRequest = z.infer<typeof nativeEventPageRequestSchema>;
const queuedPromptRequestEventLogSchema = z
    .object({
        commandId: identifier,
        content: z.array(contentBlockSchema).min(1).max(100).readonly(),
        disposition: shortString.optional(),
        targetCommandId: identifier.optional(),
    })
    .readonly();
export type QueuedPromptRequestEventLog = z.infer<typeof queuedPromptRequestEventLogSchema>;
export const nativeSessionEventsSchema = z
    .object({
        events: sessionEventLogPageSchema,
        queuedPromptRequests: z.array(queuedPromptRequestEventLogSchema).max(MAX_COLLECTION_SIZE).readonly(),
    })
    .readonly();
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
function encode<T>(value: T, schema: z.ZodType<T>): string {
    return JSON.stringify(decode(value, schema));
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
    const page = input["events"];
    const queuedPromptRequests = input["queuedPromptRequests"];
    return {
        ...input,
        events: sanitizeConsumableSessionEventLogPage(page),
        queuedPromptRequests: decodedEntries(
            queuedPromptRequests,
            queuedPromptRequestEventLogSchema,
            MAX_COLLECTION_SIZE,
        ),
    };
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
export const decodeSessionWireEnvelope = (value: unknown): SessionWireEnvelope =>
    decode(value, sessionWireEnvelopeSchema);
export const decodeKnownSessionLiveEventBatch = (value: unknown): SessionLiveEventBatch =>
    decode(
        decodedEntries(inputValue(value), sessionLiveEventSchema, SESSION_EVENT_BATCH_MAX_SIZE),
        knownSessionLiveEventBatchSchema,
    );
export const decodeSessionEventEnvelope = (value: unknown): SessionEventEnvelope =>
    decode(value, sessionEventEnvelopeSchema);
export const encodeSessionEventEnvelope = (value: SessionEventEnvelope): string =>
    encode(value, sessionEventEnvelopeSchema);
export const decodeAcpSessionUpdate = (value: unknown): AcpSessionUpdate => decode(value, acpSessionUpdateSchema);
export const decodeKnownSessionEventLogPage = (value: unknown): SessionEventLogPage =>
    decode(sanitizeConsumableSessionEventLogPage(value), sessionEventLogPageSchema);
export const decodeNativeSessionEvents = (value: unknown): NativeSessionEvents =>
    decode(value, nativeSessionEventsSchema);
export const decodeKnownNativeSessionEvents = (value: unknown): NativeSessionEvents =>
    decode(sanitizeConsumableNativeSessionEvents(value), nativeSessionEventsSchema);
