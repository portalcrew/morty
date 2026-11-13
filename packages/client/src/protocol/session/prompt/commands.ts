import { z } from "zod";
import { encryptedMessageCodec } from "../../shared/encrypted-message.ts";
import {
    identifierStringSchema as IDENTIFIER,
    identifierStringSchema as routingIdentifier,
} from "../../shared/identifier.ts";
import {
    assertKind,
    decodeZodMessage as decodeRoutingZodMessage,
    decodeZodMessage,
    decodeZodValue,
    encodeZodMessage,
    encryptedFieldSchema,
    ProtocolMessageError,
    parseJson,
    readIdentifier,
    readText,
} from "../../shared/message-codec.ts";
import type { SessionConfigurationSelection } from "../configuration/index.ts";
import { decodeSessionConfigurationSelections } from "../configuration/index.ts";
import {
    type NativeSessionTarget,
    nativeSessionTargetSchema,
    nativeSessionTargetSchema as routingTarget,
} from "../shared/native-session-target.ts";

export const SESSION_PROMPT_KIND = "session.prompt";
export const SESSION_PROMPT_DISPOSITION_KIND = "session.prompt.disposition";
export const SESSION_CANCEL_KIND = "session.cancel";
export const SESSION_CANCEL_BEFORE_START_KIND = "session.cancel-before-start";
export const SESSION_PROMPT_STEERED_KIND = "session.prompt.steered";
export const SESSION_TURN_STOPPED_KIND = "session.turn.stopped";
export const SESSION_TURN_WITHDRAWN_KIND = "session.turn.withdrawn";

/**
 * How a prompt joins its Session. An appended prompt runs when nothing earlier is waiting or running, and otherwise
 * waits at the end of the Session's queue; the Computer alone decides which. A steering prompt joins the running command
 * it names, and is refused without being admitted when that command is not running.
 */
export const SessionPromptDisposition = Object.freeze({
    Append: "append",
    Steer: "steer",
});

const MAX_PROMPT_LENGTH = 100_000;
export const MAX_PROMPT_ATTACHMENT_BYTES = 32 * 1024 * 1024;

type SessionPromptPlacement =
    | { readonly disposition: typeof SessionPromptDisposition.Append }
    | { readonly disposition: typeof SessionPromptDisposition.Steer; readonly targetCommandId: string };

/** A prompt for an existing Session. The Computer runs it with the Agent and directory of the Session it holds. */
export type SessionPromptCommand = {
    readonly commandId: string;
    readonly requestId: string;
    readonly attachments: readonly PromptAttachment[];
    readonly kind: typeof SESSION_PROMPT_KIND;
    readonly prompt: string;
    readonly sessionConfigurations?: readonly SessionConfigurationSelection[];
    readonly target: NativeSessionTarget;
} & SessionPromptPlacement;

/*
 * The command identifier names the Turn and remains its idempotency identity. The request identifier addresses the
 * response, independently of the command identifier.
 */

/** Stops the Turn; answered by `session.turn.stopped` once the Turn has ended, with the reason it ended. */
export interface SessionCancelCommand {
    readonly commandId: string;
    readonly kind: typeof SESSION_CANCEL_KIND;
    readonly requestId: string;
    readonly target: NativeSessionTarget;
}

/**
 * Cancels only work that has not started; it must never degrade into cancellation of running work. Answered by
 * `session.turn.withdrawn`, or by a `turn_already_started` failure.
 */
export interface SessionCancelBeforeStartCommand {
    readonly commandId: string;
    readonly kind: typeof SESSION_CANCEL_BEFORE_START_KIND;
    readonly requestId: string;
    readonly target: NativeSessionTarget;
}

export function decodeSessionCancelBeforeStartCommand(encoded: string): SessionCancelBeforeStartCommand {
    const value = parseJson(encoded);
    assertKind(value, SESSION_CANCEL_BEFORE_START_KIND);
    return {
        commandId: readIdentifier(value, "commandId"),
        kind: SESSION_CANCEL_BEFORE_START_KIND,
        requestId: readIdentifier(value, "requestId"),
        target: decodeZodValue(value["target"], nativeSessionTargetSchema),
    };
}

export const encodeSessionCancelBeforeStartCommand = (message: SessionCancelBeforeStartCommand): string =>
    JSON.stringify(decodeSessionCancelBeforeStartCommand(JSON.stringify(message)));

/** Steers a queued prompt into the running Turn; answered by `session.prompt.steered` once it has started. */
export interface SessionPromptDispositionCommand {
    readonly commandId: string;
    readonly disposition: typeof SessionPromptDisposition.Steer;
    readonly kind: typeof SESSION_PROMPT_DISPOSITION_KIND;
    readonly requestId: string;
    readonly target: NativeSessionTarget;
}

export const promptAttachmentSchema = z
    .object({
        byteLength: z.number().int().positive().max(MAX_PROMPT_ATTACHMENT_BYTES),
        contentKey: z.string().regex(/^[a-f0-9]{64}$/u),
        kind: z.enum(["image", "resource"]),
        mimeType: z.string().min(1).max(255),
        name: z.string().min(1).max(500),
        uri: z.string().min(1).max(4_096),
    })
    .readonly();

export type PromptAttachment = z.infer<typeof promptAttachmentSchema>;

export const decodePromptAttachment = (value: unknown): PromptAttachment =>
    decodeZodValue(value, promptAttachmentSchema);
const decodePromptAttachmentsValue = (value: unknown): readonly PromptAttachment[] =>
    decodeZodValue(value, z.array(promptAttachmentSchema).max(16).readonly());

function readPromptPlacement(value: Readonly<Record<string, unknown>>): SessionPromptPlacement {
    switch (value["disposition"]) {
        case SessionPromptDisposition.Append:
            if (Object.hasOwn(value, "targetCommandId")) {
                throw new ProtocolMessageError("An appended prompt names no target command");
            }
            return { disposition: SessionPromptDisposition.Append };
        case SessionPromptDisposition.Steer:
            return {
                disposition: SessionPromptDisposition.Steer,
                targetCommandId: readIdentifier(value, "targetCommandId"),
            };
        default:
            throw new ProtocolMessageError("Invalid value field: disposition");
    }
}

export function decodeSessionPromptCommand(encoded: string): SessionPromptCommand {
    const value = parseJson(encoded);
    const hasSessionConfigurations = Object.hasOwn(value, "sessionConfigurations");
    assertKind(value, SESSION_PROMPT_KIND);

    const commandId = readIdentifier(value, "commandId");
    const requestId = readIdentifier(value, "requestId");

    const prompt = readText(value, "prompt", MAX_PROMPT_LENGTH);
    const attachments = decodePromptAttachmentsValue(value["attachments"]);
    const attachmentBytes = attachments.reduce((total, attachment) => total + attachment.byteLength, 0);
    if (attachmentBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
        throw new ProtocolMessageError("Prompt attachments are too large");
    }
    if (prompt.trim().length === 0 && attachments.length === 0) {
        throw new ProtocolMessageError("Prompt must contain content");
    }

    const placement = readPromptPlacement(value);

    const sessionConfigurations = hasSessionConfigurations
        ? decodeSessionConfigurationSelections(value["sessionConfigurations"])
        : [];
    if (new Set(sessionConfigurations.map((selection) => selection.configId)).size !== sessionConfigurations.length) {
        throw new ProtocolMessageError("Session configuration identifiers must be unique");
    }

    return {
        commandId,
        requestId,
        attachments,
        kind: SESSION_PROMPT_KIND,
        prompt,
        ...(hasSessionConfigurations ? { sessionConfigurations } : {}),
        target: decodeZodValue(value["target"], nativeSessionTargetSchema),
        ...placement,
    };
}

export function decodeSessionCancelCommand(encoded: string): SessionCancelCommand {
    const value = parseJson(encoded);
    assertKind(value, SESSION_CANCEL_KIND);

    return {
        commandId: readIdentifier(value, "commandId"),
        kind: SESSION_CANCEL_KIND,
        requestId: readIdentifier(value, "requestId"),
        target: decodeZodValue(value["target"], nativeSessionTargetSchema),
    };
}

export function decodeSessionPromptDispositionCommand(encoded: string): SessionPromptDispositionCommand {
    const value = parseJson(encoded);
    assertKind(value, SESSION_PROMPT_DISPOSITION_KIND);
    if (value["disposition"] !== SessionPromptDisposition.Steer) {
        throw new ProtocolMessageError("Only queued prompts can be steered");
    }
    return {
        commandId: readIdentifier(value, "commandId"),
        disposition: SessionPromptDisposition.Steer,
        kind: SESSION_PROMPT_DISPOSITION_KIND,
        requestId: readIdentifier(value, "requestId"),
        target: decodeZodValue(value["target"], nativeSessionTargetSchema),
    };
}

export function encodeSessionPromptCommand(message: SessionPromptCommand): string {
    return JSON.stringify(decodeSessionPromptCommand(JSON.stringify(message)));
}

export function encodeSessionCancelCommand(message: SessionCancelCommand): string {
    return JSON.stringify(decodeSessionCancelCommand(JSON.stringify(message)));
}

export function encodeSessionPromptDispositionCommand(message: SessionPromptDispositionCommand): string {
    return JSON.stringify(decodeSessionPromptDispositionCommand(JSON.stringify(message)));
}

const turnReplyFields = {
    commandId: IDENTIFIER,
    requestId: IDENTIFIER,
    target: nativeSessionTargetSchema,
} as const;

const sessionPromptSteeredEventSchema = z
    .object({ ...turnReplyFields, kind: z.literal(SESSION_PROMPT_STEERED_KIND) })
    .readonly();

export type SessionPromptSteeredEvent = z.infer<typeof sessionPromptSteeredEventSchema>;

const sessionTurnStoppedEventSchema = z
    .object({ ...turnReplyFields, kind: z.literal(SESSION_TURN_STOPPED_KIND), stopReason: z.string().min(1).max(128) })
    .readonly();

export type SessionTurnStoppedEvent = z.infer<typeof sessionTurnStoppedEventSchema>;

const sessionTurnWithdrawnEventSchema = z
    .object({ ...turnReplyFields, kind: z.literal(SESSION_TURN_WITHDRAWN_KIND) })
    .readonly();

export type SessionTurnWithdrawnEvent = z.infer<typeof sessionTurnWithdrawnEventSchema>;

export const decodeSessionPromptSteeredEvent = (encoded: string): SessionPromptSteeredEvent =>
    decodeZodMessage(encoded, sessionPromptSteeredEventSchema);
export const encodeSessionPromptSteeredEvent = (message: SessionPromptSteeredEvent): string =>
    encodeZodMessage(message, sessionPromptSteeredEventSchema);
export const decodeSessionTurnStoppedEvent = (encoded: string): SessionTurnStoppedEvent =>
    decodeZodMessage(encoded, sessionTurnStoppedEventSchema);
export const encodeSessionTurnStoppedEvent = (message: SessionTurnStoppedEvent): string =>
    encodeZodMessage(message, sessionTurnStoppedEventSchema);
export const decodeSessionTurnWithdrawnEvent = (encoded: string): SessionTurnWithdrawnEvent =>
    decodeZodMessage(encoded, sessionTurnWithdrawnEventSchema);
export const encodeSessionTurnWithdrawnEvent = (message: SessionTurnWithdrawnEvent): string =>
    encodeZodMessage(message, sessionTurnWithdrawnEventSchema);

const sessionCancelBeforeStartCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_CANCEL_BEFORE_START_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
    commandId: routingIdentifier,
});
const sessionCancelBeforeStartCommandRoutingSchema = sessionCancelBeforeStartCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionCancelBeforeStartCommandRouting = z.infer<typeof sessionCancelBeforeStartCommandRoutingSchema>;
const decodeSessionCancelBeforeStartCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionCancelBeforeStartCommandRoutingSchema);
export const sessionCancelBeforeStartCommandCodec = encryptedMessageCodec({
    kind: SESSION_CANCEL_BEFORE_START_KIND,
    decode: decodeSessionCancelBeforeStartCommand,
    decodeRouting: decodeSessionCancelBeforeStartCommandRouting,
    publicRoutingSchema: sessionCancelBeforeStartCommandPublicRoutingSchema,
});

const sessionCancelCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_CANCEL_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
    commandId: routingIdentifier,
});
const sessionCancelCommandRoutingSchema = sessionCancelCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionCancelCommandRouting = z.infer<typeof sessionCancelCommandRoutingSchema>;
const decodeSessionCancelCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionCancelCommandRoutingSchema);
export const sessionCancelCommandCodec = encryptedMessageCodec({
    kind: SESSION_CANCEL_KIND,
    decode: decodeSessionCancelCommand,
    decodeRouting: decodeSessionCancelCommandRouting,
    publicRoutingSchema: sessionCancelCommandPublicRoutingSchema,
});

const sessionPromptCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_PROMPT_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
    commandId: routingIdentifier,
});
const sessionPromptCommandRoutingSchema = sessionPromptCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionPromptCommandRouting = z.infer<typeof sessionPromptCommandRoutingSchema>;
const decodeSessionPromptCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionPromptCommandRoutingSchema);
export const sessionPromptCommandCodec = encryptedMessageCodec({
    kind: SESSION_PROMPT_KIND,
    decode: decodeSessionPromptCommand,
    decodeRouting: decodeSessionPromptCommandRouting,
    publicRoutingSchema: sessionPromptCommandPublicRoutingSchema,
});

const sessionPromptDispositionCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_PROMPT_DISPOSITION_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
    commandId: routingIdentifier,
});
const sessionPromptDispositionCommandRoutingSchema = sessionPromptDispositionCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionPromptDispositionCommandRouting = z.infer<typeof sessionPromptDispositionCommandRoutingSchema>;
const decodeSessionPromptDispositionCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionPromptDispositionCommandRoutingSchema);
export const sessionPromptDispositionCommandCodec = encryptedMessageCodec({
    kind: SESSION_PROMPT_DISPOSITION_KIND,
    decode: decodeSessionPromptDispositionCommand,
    decodeRouting: decodeSessionPromptDispositionCommandRouting,
    publicRoutingSchema: sessionPromptDispositionCommandPublicRoutingSchema,
});

const sessionPromptSteeredEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_PROMPT_STEERED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
    commandId: routingIdentifier,
});
const sessionPromptSteeredEventRoutingSchema = sessionPromptSteeredEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionPromptSteeredEventRouting = z.infer<typeof sessionPromptSteeredEventRoutingSchema>;
const decodeSessionPromptSteeredEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionPromptSteeredEventRoutingSchema);
export const sessionPromptSteeredEventCodec = encryptedMessageCodec({
    kind: SESSION_PROMPT_STEERED_KIND,
    decode: decodeSessionPromptSteeredEvent,
    decodeRouting: decodeSessionPromptSteeredEventRouting,
    publicRoutingSchema: sessionPromptSteeredEventPublicRoutingSchema,
});

const sessionTurnStoppedEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_TURN_STOPPED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
    commandId: routingIdentifier,
});
const sessionTurnStoppedEventRoutingSchema = sessionTurnStoppedEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionTurnStoppedEventRouting = z.infer<typeof sessionTurnStoppedEventRoutingSchema>;
const decodeSessionTurnStoppedEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionTurnStoppedEventRoutingSchema);
export const sessionTurnStoppedEventCodec = encryptedMessageCodec({
    kind: SESSION_TURN_STOPPED_KIND,
    decode: decodeSessionTurnStoppedEvent,
    decodeRouting: decodeSessionTurnStoppedEventRouting,
    publicRoutingSchema: sessionTurnStoppedEventPublicRoutingSchema,
});

const sessionTurnWithdrawnEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_TURN_WITHDRAWN_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
    commandId: routingIdentifier,
});
const sessionTurnWithdrawnEventRoutingSchema = sessionTurnWithdrawnEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionTurnWithdrawnEventRouting = z.infer<typeof sessionTurnWithdrawnEventRoutingSchema>;
const decodeSessionTurnWithdrawnEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionTurnWithdrawnEventRoutingSchema);
export const sessionTurnWithdrawnEventCodec = encryptedMessageCodec({
    kind: SESSION_TURN_WITHDRAWN_KIND,
    decode: decodeSessionTurnWithdrawnEvent,
    decodeRouting: decodeSessionTurnWithdrawnEventRouting,
    publicRoutingSchema: sessionTurnWithdrawnEventPublicRoutingSchema,
});
