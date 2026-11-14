import { z } from "zod";
import { DIRECTORY_PATH as directory, MAX_WORKSPACE_PATH_LENGTH } from "../../shared/directory.ts";
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
import { promptDelegationStageSchema } from "../events/index.ts";
import {
    sessionElicitationAwaitingCompletionEventSchema,
    sessionElicitationRequestedEventSchema,
    sessionPermissionRequestedEventSchema,
} from "../interactions/index.ts";
import { sessionReadyBodySchema } from "../lifecycle/index.ts";
import { promptAttachmentSchema } from "../prompt/commands.ts";
import { sessionCapabilitiesSchema } from "../shared/index.ts";
import { nativeSessionTargetSchema } from "../shared/native-session-target.ts";

export const NATIVE_SESSION_REQUEST_KIND = "native.session.request";
export const NATIVE_SESSION_RESULT_KIND = "native.session.result";
export const NATIVE_SESSION_CANCEL_KIND = "native.session.cancel";

const envelope = {
    requestId: identifier,
};
const sessionInteractionSnapshotSchema = z
    .object({
        sessionGenerationId: identifier,
        throughPosition: z.string().regex(/^(0|[1-9][0-9]*)$/),
        interactions: z
            .array(
                z.discriminatedUnion("kind", [
                    sessionPermissionRequestedEventSchema,
                    sessionElicitationRequestedEventSchema,
                    sessionElicitationAwaitingCompletionEventSchema,
                ]),
            )
            .readonly(),
    })
    .readonly();
export type SessionInteractionSnapshot = z.infer<typeof sessionInteractionSnapshotSchema>;

const activeTurnSnapshotSchema = z
    .object({
        commandId: identifier,
        // When the Computer recorded the start of this running turn.
        startedAt: z.iso.datetime({ offset: true }),
        // How far the native session's owner has taken the command when the Computer handed it there, and when it
        // reached that stage; null when the Computer runs the command itself.
        delegation: z
            .object({ stage: promptDelegationStageSchema, at: z.iso.datetime({ offset: true }) })
            .readonly()
            .nullable(),
    })
    .readonly();

/**
 * Where one submitted command stands in the Computer's execution receipts. Only the
 * Computer that receives a command can say whether it arrived, so a client recovers an
 * unconfirmed submission from this rather than from Agent message identities.
 */
const commandDeliverySchema = z.discriminatedUnion("state", [
    // No receipt: the command has not arrived. A delayed submission may still arrive later.
    z.object({ state: z.literal("unknown") }).readonly(),
    // The Computer holds the command and has not finished it; it may be waiting or running.
    z.object({ state: z.literal("accepted") }).readonly(),
    z.object({ state: z.literal("completed"), stopReason: z.string().max(2_048) }).readonly(),
    z.object({ code: identifier, state: z.literal("failed") }).readonly(),
    // The command started, but the Computer no longer retains its result.
    z.object({ state: z.literal("expired") }).readonly(),
]);
export type CommandDelivery = z.infer<typeof commandDeliverySchema>;

/**
 * How the Session's most recent started command ended, from the Computer's execution receipts.
 * A client that missed the live outcome, after leaving, reloading or reconnecting, shows it from
 * this. While the Computer retains the live receipt, a failure carries its bounded client-facing
 * lifecycle message. After a Computer restart, it carries the sanitized
 * durable summary: Agent error text may quote user input and is not persisted in receipts.
 */
const lastTurnOutcomeSchema = z.discriminatedUnion("state", [
    z.object({ commandId: identifier, state: z.literal("completed"), stopReason: z.string().max(2_048) }).readonly(),
    z
        .object({
            code: identifier,
            commandId: identifier,
            message: z.string().min(1).max(500),
            state: z.literal("failed"),
        })
        .readonly(),
]);
export type LastTurnOutcome = z.infer<typeof lastTurnOutcomeSchema>;

const requestEnvelope = {
    ...envelope,
    kind: z.literal(NATIVE_SESSION_REQUEST_KIND),
};
// An Agent's own sessions on disk exist before any Morty Session does, so browsing them names the Agent and directory.
const agentDirectory = {
    ...requestEnvelope,
    harness: identifier,
    directory,
};

const nativeSessionRequestSchema = z.discriminatedUnion("action", [
    z
        .object({
            ...requestEnvelope,
            action: z.literal("active-turn"),
            // Asks the Computer for this command's delivery alongside the execution snapshot. It is not
            // named `commandId`, which routes a request as the command it names.
            deliveryCommandId: identifier.optional(),
            // The Computer reads the Session it holds for this target.
            target: nativeSessionTargetSchema,
        })
        .readonly(),
    z.object({ ...agentDirectory, action: z.literal("find"), sessionId: identifier }).readonly(),
    z
        .object({
            ...agentDirectory,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...agentDirectory,
            action: z.enum(["import", "fork"]),
            sessionId: identifier,
        })
        .readonly(),
]);
export type NativeSessionRequest = z.infer<typeof nativeSessionRequestSchema>;
const nativeSessionCommandSchema = z.discriminatedUnion("action", [
    z
        .object({
            ...requestEnvelope,
            action: z.literal("active-turn"),
            // Asks the Computer for this command's delivery alongside the execution snapshot. It is not
            // named `commandId`, which routes a request as the command it names.
            deliveryCommandId: identifier.optional(),
            // The Computer reads the Session it holds for this target.
            target: nativeSessionTargetSchema,
        })
        .readonly(),
    z.object({ ...agentDirectory, action: z.literal("find"), sessionId: identifier }).readonly(),
    z
        .object({
            ...agentDirectory,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...agentDirectory,
            action: z.enum(["import", "fork"]),
            sessionId: identifier,
        })
        .readonly(),
]);
export type NativeSessionCommand = z.infer<typeof nativeSessionCommandSchema>;

const nativeSessionEntrySchema = z
    .object({
        sessionId: identifier,
        title: z.string().max(500),
        directory,
        directoryLabel: z.string().min(1).max(MAX_WORKSPACE_PATH_LENGTH),
        updatedAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .readonly();
export type NativeSessionEntry = z.infer<typeof nativeSessionEntrySchema>;

const resultEnvelope = {
    ...envelope,
    kind: z.literal(NATIVE_SESSION_RESULT_KIND),
};
const executionReadFields = {
    ...resultEnvelope,
    action: z.literal("active-turn"),
    target: nativeSessionTargetSchema,
    queued: z
        .array(
            z
                .object({
                    commandId: identifier,
                    prompt: z.string().max(100_000),
                    attachments: z.array(promptAttachmentSchema).max(16).readonly(),
                })
                .readonly(),
        )
        .readonly(),
    // The whole execution read covers this prefix of the Session event log.
    executionPosition: z
        .object({
            sessionGenerationId: identifier,
            throughPosition: z.string().regex(/^(0|[1-9][0-9]*)$/),
        })
        .readonly(),
    // Null when this Computer has no retained Session for the requested identity.
    interactionState: sessionInteractionSnapshotSchema.nullable(),
    // Present only when the request named a command.
    command: commandDeliverySchema.optional(),
};
/**
 * What reading a Session's execution answers: a running turn, or none and how the last started command ended. How a
 * command ended is told only while none runs, and not at all before one has started.
 */
const runningTurnResultSchema = z
    .object({ ...executionReadFields, lastTurn: z.never().optional(), turn: activeTurnSnapshotSchema })
    .readonly();
const idleTurnResultSchema = z
    .object({ ...executionReadFields, lastTurn: lastTurnOutcomeSchema.optional(), turn: z.null() })
    .readonly();
const activeTurnResultSchema = z.union([runningTurnResultSchema, idleTurnResultSchema]);
/** A Session's execution as one read answers it, without the addressing every native result carries. */
export type SessionExecution =
    z.infer<typeof activeTurnResultSchema> extends infer Read
        ? Read extends unknown
            ? Omit<Read, "action" | "kind" | "requestId" | "target">
            : never
        : never;
// A union of its own variants, not discriminated by `action`: the two reads of an execution share theirs.
const nativeSessionResultSchema = z.union([
    runningTurnResultSchema,
    idleTurnResultSchema,
    z
        .object({
            ...resultEnvelope,
            action: z.literal("find"),
            entry: nativeSessionEntrySchema,
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.literal("list"),
            capabilities: sessionCapabilitiesSchema,
            entries: z.array(nativeSessionEntrySchema).max(500).readonly(),
            nextCursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.enum(["import", "fork"]),
            target: nativeSessionTargetSchema,
            ready: sessionReadyBodySchema,
            title: z.string().max(500),
        })
        .readonly(),
]);
export type NativeSessionResult = z.infer<typeof nativeSessionResultSchema>;

const nativeSessionCancelSchema = z.object({ ...envelope, kind: z.literal(NATIVE_SESSION_CANCEL_KIND) }).readonly();
export type NativeSessionCancel = z.infer<typeof nativeSessionCancelSchema>;
function decode<T>(schema: z.ZodType<T>, encoded: string): T {
    try {
        const value: unknown = JSON.parse(encoded);
        return schema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid native session message", { cause });
    }
}

const decodeNativeSessionCommand = (encoded: string): NativeSessionCommand =>
    decode(nativeSessionCommandSchema, encoded);
export const encodeNativeSessionCommand = (value: NativeSessionCommand): string =>
    JSON.stringify(nativeSessionCommandSchema.parse(value));
export const decodeNativeSessionRequest = (encoded: string): NativeSessionRequest =>
    decode(nativeSessionRequestSchema, encoded);
export const encodeNativeSessionRequest = (value: NativeSessionRequest): string =>
    JSON.stringify(nativeSessionRequestSchema.parse(value));
export const decodeNativeSessionResult = (encoded: string): NativeSessionResult =>
    decode(nativeSessionResultSchema, encoded);
const decodeNativeSessionCancel = (encoded: string): NativeSessionCancel => decode(nativeSessionCancelSchema, encoded);
export const encodeNativeSessionCancel = (value: NativeSessionCancel): string =>
    JSON.stringify(nativeSessionCancelSchema.parse(value));

const nativeSessionCancelPublicRoutingSchema = z.object({
    kind: z.literal(NATIVE_SESSION_CANCEL_KIND),
    requestId: routingIdentifier,
});
const nativeSessionCancelRoutingSchema = nativeSessionCancelPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeNativeSessionCancelRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, nativeSessionCancelRoutingSchema);
export const nativeSessionCancelCodec = encryptedMessageCodec({
    kind: NATIVE_SESSION_CANCEL_KIND,
    decode: decodeNativeSessionCancel,
    decodeRouting: decodeNativeSessionCancelRouting,
    publicRoutingSchema: nativeSessionCancelPublicRoutingSchema,
});

const nativeSessionCommandPublicRoutingSchema = z.object({
    kind: z.literal(NATIVE_SESSION_REQUEST_KIND),
    requestId: routingIdentifier,
});
const nativeActiveTurnPublicRoutingSchema = nativeSessionCommandPublicRoutingSchema.extend({
    action: z.literal("active-turn"),
    target: nativeSessionTargetSchema,
});
const nativeListPublicRoutingSchema = nativeSessionCommandPublicRoutingSchema.extend({
    action: z.literal("list"),
    harness: routingIdentifier,
});
const nativeTargetedPublicRoutingSchema = nativeSessionCommandPublicRoutingSchema.extend({
    action: z.enum(["find", "import", "fork"]),
    target: nativeSessionTargetSchema,
});
const nativeActiveTurnRoutingSchema = nativeActiveTurnPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const nativeListRoutingSchema = nativeListPublicRoutingSchema.extend({ encrypted: encryptedFieldSchema }).strict();
const nativeTargetedRoutingSchema = nativeTargetedPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const nativeSessionCommandRoutingSchema = z.discriminatedUnion("action", [
    nativeActiveTurnRoutingSchema,
    nativeListRoutingSchema,
    nativeTargetedRoutingSchema.extend({ action: z.literal("find") }),
    nativeTargetedRoutingSchema.extend({ action: z.literal("import") }),
    nativeTargetedRoutingSchema.extend({ action: z.literal("fork") }),
]);
export type NativeSessionCommandRouting = z.infer<typeof nativeSessionCommandRoutingSchema>;
const decodeNativeSessionCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, nativeSessionCommandRoutingSchema);

function decodeActiveTurnCommand(encoded: string) {
    const message = decodeNativeSessionCommand(encoded);
    if (message.action !== "active-turn") {
        throw new ProtocolMessageError("Native session request does not match its route");
    }
    return message;
}

function decodeNativeListCommand(encoded: string) {
    const message = decodeNativeSessionCommand(encoded);
    if (message.action !== "list") {
        throw new ProtocolMessageError("Native session request does not match its route");
    }
    return message;
}

function decodeTargetedNativeSessionCommand(encoded: string) {
    const message = decodeNativeSessionCommand(encoded);
    if (message.action === "active-turn" || message.action === "list") {
        throw new ProtocolMessageError("Native session request does not match its route");
    }
    const { target } = decodeRoutingZodMessage(encoded, nativeTargetedPublicRoutingSchema);
    if (message.harness !== target.harness || message.sessionId !== target.sessionId) {
        throw new ProtocolMessageError("Native session request target does not match its route");
    }
    return { ...message, target };
}

const nativeActiveTurnCodec = encryptedMessageCodec({
    kind: NATIVE_SESSION_REQUEST_KIND,
    decode: decodeActiveTurnCommand,
    decodeRouting: (encoded: string) => decodeRoutingZodMessage(encoded, nativeActiveTurnRoutingSchema),
    publicRoutingSchema: nativeActiveTurnPublicRoutingSchema,
});
const nativeListCommandCodec = encryptedMessageCodec({
    kind: NATIVE_SESSION_REQUEST_KIND,
    decode: decodeNativeListCommand,
    decodeRouting: (encoded: string) => decodeRoutingZodMessage(encoded, nativeListRoutingSchema),
    publicRoutingSchema: nativeListPublicRoutingSchema,
});
const nativeTargetedCommandCodec = encryptedMessageCodec({
    kind: NATIVE_SESSION_REQUEST_KIND,
    decode: decodeTargetedNativeSessionCommand,
    decodeRouting: (encoded: string) => decodeRoutingZodMessage(encoded, nativeTargetedRoutingSchema),
    publicRoutingSchema: nativeTargetedPublicRoutingSchema,
});
export const nativeSessionCommandCodec = Object.freeze({
    kind: NATIVE_SESSION_REQUEST_KIND,
    decodeRouting: decodeNativeSessionCommandRouting,
    encodeRouting: (message: NativeSessionCommandRouting): string =>
        JSON.stringify(decodeNativeSessionCommandRouting(JSON.stringify(message))),
    encode: async (
        value: unknown,
        encryptor: Parameters<typeof nativeActiveTurnCodec.encode>[1],
        signal: AbortSignal,
    ): Promise<string> => {
        const message = decodeNativeSessionCommand(JSON.stringify(value));
        switch (message.action) {
            case "active-turn":
                return nativeActiveTurnCodec.encode(message, encryptor, signal);
            case "list":
                return nativeListCommandCodec.encode(message, encryptor, signal);
            case "find":
            case "import":
            case "fork":
                return nativeTargetedCommandCodec.encode(
                    { ...message, target: { harness: message.harness, sessionId: message.sessionId } },
                    encryptor,
                    signal,
                );
        }
    },
    decode: async (
        encoded: string,
        decryptor: Parameters<typeof nativeActiveTurnCodec.decode>[1],
        signal: AbortSignal,
    ): Promise<NativeSessionCommand> => {
        const routing = decodeNativeSessionCommandRouting(encoded);
        switch (routing.action) {
            case "active-turn":
                return nativeActiveTurnCodec.decode(encoded, decryptor, signal);
            case "list":
                return nativeListCommandCodec.decode(encoded, decryptor, signal);
            case "find":
            case "import":
            case "fork": {
                const { target: _target, ...message } = await nativeTargetedCommandCodec.decode(
                    encoded,
                    decryptor,
                    signal,
                );
                return message;
            }
        }
    },
});
const nativeSessionResultPublicRoutingSchema = z.object({
    kind: z.literal(NATIVE_SESSION_RESULT_KIND),
    requestId: routingIdentifier,
});
const nativeTargetedResultPublicRoutingSchema = nativeSessionResultPublicRoutingSchema.extend({
    action: z.enum(["active-turn", "import", "fork"]),
    target: nativeSessionTargetSchema,
});
const nativeBrowseResultPublicRoutingSchema = nativeSessionResultPublicRoutingSchema.extend({
    action: z.enum(["find", "list"]),
});
const nativeTargetedResultRoutingSchema = nativeTargetedResultPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const nativeBrowseResultRoutingSchema = nativeBrowseResultPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const nativeSessionResultRoutingSchema = z.discriminatedUnion("action", [
    nativeTargetedResultRoutingSchema.extend({ action: z.literal("active-turn") }),
    nativeTargetedResultRoutingSchema.extend({ action: z.literal("import") }),
    nativeTargetedResultRoutingSchema.extend({ action: z.literal("fork") }),
    nativeBrowseResultRoutingSchema.extend({ action: z.literal("find") }),
    nativeBrowseResultRoutingSchema.extend({ action: z.literal("list") }),
]);
export function nativeWireJsonSchemas() {
    return {
        activeTurnRequest: z.toJSONSchema(nativeActiveTurnRoutingSchema),
        continuationRequest: z.toJSONSchema(nativeTargetedRoutingSchema.extend({ action: z.enum(["find", "import"]) })),
        activeTurnReply: z.toJSONSchema(nativeTargetedResultRoutingSchema.extend({ action: z.literal("active-turn") })),
        continuationReply: z.toJSONSchema(
            z.discriminatedUnion("action", [
                nativeBrowseResultRoutingSchema.extend({ action: z.literal("find") }),
                nativeTargetedResultRoutingSchema.extend({ action: z.literal("import") }),
            ]),
        ),
    };
}
export type NativeSessionResultRouting = z.infer<typeof nativeSessionResultRoutingSchema>;
const decodeNativeSessionResultRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, nativeSessionResultRoutingSchema);

function decodeTargetedNativeSessionResult(encoded: string) {
    const message = decodeNativeSessionResult(encoded);
    if (message.action === "find" || message.action === "list") {
        throw new ProtocolMessageError("Native session result does not match its route");
    }
    return message;
}
function decodeBrowseNativeSessionResult(encoded: string) {
    const message = decodeNativeSessionResult(encoded);
    if (message.action !== "find" && message.action !== "list") {
        throw new ProtocolMessageError("Native session result does not match its route");
    }
    return message;
}
const nativeTargetedResultCodec = encryptedMessageCodec({
    kind: NATIVE_SESSION_RESULT_KIND,
    decode: decodeTargetedNativeSessionResult,
    decodeRouting: (encoded: string) => decodeRoutingZodMessage(encoded, nativeTargetedResultRoutingSchema),
    publicRoutingSchema: nativeTargetedResultPublicRoutingSchema,
});
const nativeBrowseResultCodec = encryptedMessageCodec({
    kind: NATIVE_SESSION_RESULT_KIND,
    decode: decodeBrowseNativeSessionResult,
    decodeRouting: (encoded: string) => decodeRoutingZodMessage(encoded, nativeBrowseResultRoutingSchema),
    publicRoutingSchema: nativeBrowseResultPublicRoutingSchema,
});
export const nativeSessionResultCodec = Object.freeze({
    kind: NATIVE_SESSION_RESULT_KIND,
    decodeRouting: decodeNativeSessionResultRouting,
    encodeRouting: (message: NativeSessionResultRouting): string =>
        JSON.stringify(decodeNativeSessionResultRouting(JSON.stringify(message))),
    encode: async (
        value: unknown,
        encryptor: Parameters<typeof nativeTargetedResultCodec.encode>[1],
        signal: AbortSignal,
    ): Promise<string> => {
        const message = decodeNativeSessionResult(JSON.stringify(value));
        switch (message.action) {
            case "active-turn":
            case "import":
            case "fork":
                return nativeTargetedResultCodec.encode(message, encryptor, signal);
            case "find":
            case "list":
                return nativeBrowseResultCodec.encode(message, encryptor, signal);
        }
    },
    decode: async (
        encoded: string,
        decryptor: Parameters<typeof nativeTargetedResultCodec.decode>[1],
        signal: AbortSignal,
    ): Promise<NativeSessionResult> => {
        const routing = decodeNativeSessionResultRouting(encoded);
        switch (routing.action) {
            case "active-turn":
            case "import":
            case "fork":
                return nativeTargetedResultCodec.decode(encoded, decryptor, signal);
            case "find":
            case "list":
                return nativeBrowseResultCodec.decode(encoded, decryptor, signal);
        }
    },
});
