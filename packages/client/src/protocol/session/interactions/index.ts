import { z } from "zod";
import { encryptedMessageCodec } from "../../shared/encrypted-message.ts";
import {
    identifierStringSchema as IDENTIFIER,
    identifierStringSchema as routingIdentifier,
} from "../../shared/identifier.ts";
import {
    decodeZodMessage as decode,
    decodeZodMessage as decodeRoutingZodMessage,
    decodeZodValue,
    encodeZodMessage as encode,
    encryptedFieldSchema,
} from "../../shared/message-codec.ts";
import { boundedJsonSchema, toolCallLocationSchema } from "../../shared/tool-input.ts";
import { SHORT_TEXT } from "../shared/index.ts";
import {
    nativeSessionTargetSchema,
    nativeSessionTargetSchema as routingTarget,
} from "../shared/native-session-target.ts";

export const SESSION_PERMISSION_REQUESTED_KIND = "session.permission.requested";
export const SESSION_PERMISSION_RESPOND_KIND = "session.permission.respond";
export const SESSION_PERMISSION_RESOLVED_KIND = "session.permission.resolved";
export const SESSION_ELICITATION_REQUESTED_KIND = "session.elicitation.requested";
export const SESSION_ELICITATION_RESPOND_KIND = "session.elicitation.respond";
export const SESSION_ELICITATION_RESOLVED_KIND = "session.elicitation.resolved";
export const SESSION_ELICITATION_AWAITING_COMPLETION_KIND = "session.elicitation.awaiting-completion";
export const SESSION_INTERACTION_ANSWERED_KIND = "session.interaction.answered";

const permissionOptionSchema = z
    .object({
        kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
        name: z.string().min(1).max(255),
        optionId: z.string().min(1).max(255),
    })
    .readonly();

export type SessionPermissionOption = z.infer<typeof permissionOptionSchema>;

const elicitationOptionSchema = z
    .object({
        description: SHORT_TEXT,
        label: z.string().min(1).max(255),
        value: z.string().max(500),
    })
    .readonly();

export type SessionElicitationOption = z.infer<typeof elicitationOptionSchema>;

const elicitationFieldBase = {
    description: SHORT_TEXT,
    name: z.string().min(1).max(128),
    required: z.boolean(),
    title: z.string().min(1).max(255),
};
const lengthBound = z.number().int().nonnegative();

/** A form field holds only the default and the limits its own type takes. */
const elicitationFieldSchema = z.discriminatedUnion("type", [
    z.object({ ...elicitationFieldBase, default: z.boolean().optional(), type: z.literal("boolean") }).readonly(),
    z
        .object({
            ...elicitationFieldBase,
            default: z.string().max(10_000).optional(),
            format: z.string().min(1).max(64).optional(),
            maximumLength: lengthBound.optional(),
            minimumLength: lengthBound.optional(),
            multiline: z.boolean(),
            pattern: z.string().min(1).max(500).optional(),
            type: z.literal("string"),
        })
        .readonly(),
    z
        .object({
            ...elicitationFieldBase,
            default: z.number().finite().optional(),
            maximum: z.number().finite().optional(),
            minimum: z.number().finite().optional(),
            type: z.literal("integer"),
        })
        .readonly(),
    z
        .object({
            ...elicitationFieldBase,
            default: z.number().finite().optional(),
            maximum: z.number().finite().optional(),
            minimum: z.number().finite().optional(),
            type: z.literal("number"),
        })
        .readonly(),
    z
        .object({
            ...elicitationFieldBase,
            default: z.string().max(500).optional(),
            options: z.array(elicitationOptionSchema).max(200).readonly(),
            type: z.literal("select"),
        })
        .readonly(),
    z
        .object({
            ...elicitationFieldBase,
            default: z.array(z.string().max(500)).max(200).readonly().optional(),
            maximumSelections: lengthBound.optional(),
            minimumSelections: lengthBound.optional(),
            options: z.array(elicitationOptionSchema).max(200).readonly(),
            type: z.literal("multiselect"),
        })
        .readonly(),
]);

export type SessionElicitationField = z.infer<typeof elicitationFieldSchema>;

/** The value a form field is answered with. */
const elicitationAnswerValueSchema = z.union([
    z.string().max(100_000),
    z.number().finite(),
    z.boolean(),
    z.array(z.string().max(500)).max(200).readonly(),
]);

export type SessionElicitationAnswerValue = z.infer<typeof elicitationAnswerValueSchema>;

const elicitationFormContentSchema = z
    .record(z.string().min(1).max(128), elicitationAnswerValueSchema)
    .refine((content) => Object.keys(content).length <= 100 && JSON.stringify(content).length <= 100_000)
    .readonly();

export type SessionElicitationFormContent = z.infer<typeof elicitationFormContentSchema>;

export const sessionPermissionRequestedEventSchema = z
    .object({
        commandId: IDENTIFIER,
        details: z
            .object({
                cwd: z.string().min(1).max(4_096),
                rawInput: boundedJsonSchema.optional(),
                locations: z.array(toolCallLocationSchema).max(1_000).readonly(),
            })
            .readonly(),
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_PERMISSION_REQUESTED_KIND),
        options: z.array(permissionOptionSchema).min(1).max(20).readonly(),
        target: nativeSessionTargetSchema,
        title: z.string().min(1).max(500),
        toolCallId: z.string().min(1).max(255),
        toolKind: z.string().max(64),
    })
    .readonly();

export type SessionPermissionRequestedEvent = z.infer<typeof sessionPermissionRequestedEventSchema>;

const sessionPermissionRespondBase = {
    interactionId: IDENTIFIER,
    kind: z.literal(SESSION_PERMISSION_RESPOND_KIND),
    requestId: IDENTIFIER,
    target: nativeSessionTargetSchema,
};

/** An answer chooses one of the offered options, or declines them all; only a choice names an option. */
const sessionPermissionRespondCommandSchema = z.discriminatedUnion("outcome", [
    z
        .object({
            ...sessionPermissionRespondBase,
            optionId: z.string().min(1).max(255),
            outcome: z.literal("selected"),
        })
        .readonly(),
    z.object({ ...sessionPermissionRespondBase, outcome: z.literal("cancelled") }).readonly(),
]);

/**
 * Repeating the same answer succeeds within the live Session's last 256 answered permissions. A different
 * answer returns permission_response_conflict. An unavailable request is never inferred to have succeeded;
 * reconnecting clients reconcile the current interaction snapshot before offering another answer.
 */
export type SessionPermissionRespondCommand = z.infer<typeof sessionPermissionRespondCommandSchema>;

const sessionPermissionResolvedBase = {
    interactionId: IDENTIFIER,
    kind: z.literal(SESSION_PERMISSION_RESOLVED_KIND),
    target: nativeSessionTargetSchema,
};

export const sessionPermissionResolvedEventSchema = z.discriminatedUnion("outcome", [
    z
        .object({
            ...sessionPermissionResolvedBase,
            optionId: z.string().min(1).max(255),
            outcome: z.literal("selected"),
        })
        .readonly(),
    z.object({ ...sessionPermissionResolvedBase, outcome: z.literal("cancelled") }).readonly(),
]);

export type SessionPermissionResolvedEvent = z.infer<typeof sessionPermissionResolvedEventSchema>;

const sessionElicitationRequestedBase = {
    commandId: IDENTIFIER,
    interactionId: IDENTIFIER,
    kind: z.literal(SESSION_ELICITATION_REQUESTED_KIND),
    message: z.string().min(1).max(2_000),
    target: nativeSessionTargetSchema,
};
const elicitationUrlRequest = {
    elicitationId: z.string().min(1).max(255),
    url: z.string().min(1).max(4_096),
};

/** The Agent asks for a form to be filled, or for the user to visit a URL; each mode carries only its own data. */
export const sessionElicitationRequestedEventSchema = z.discriminatedUnion("mode", [
    z
        .object({
            ...sessionElicitationRequestedBase,
            fields: z.array(elicitationFieldSchema).max(100).readonly(),
            mode: z.literal("form"),
        })
        .readonly(),
    z.object({ ...sessionElicitationRequestedBase, ...elicitationUrlRequest, mode: z.literal("url") }).readonly(),
]);

export type SessionElicitationRequestedEvent = z.infer<typeof sessionElicitationRequestedEventSchema>;

/** A URL request the user accepted and the Agent has not yet completed: only a snapshot describes it. */
export const sessionElicitationAwaitingCompletionEventSchema = z
    .object({
        ...sessionElicitationRequestedBase,
        ...elicitationUrlRequest,
        kind: z.literal(SESSION_ELICITATION_AWAITING_COMPLETION_KIND),
    })
    .readonly();

export type SessionElicitationAwaitingCompletionEvent = z.infer<typeof sessionElicitationAwaitingCompletionEventSchema>;

const sessionElicitationRespondBase = {
    interactionId: IDENTIFIER,
    kind: z.literal(SESSION_ELICITATION_RESPOND_KIND),
    requestId: IDENTIFIER,
    target: nativeSessionTargetSchema,
};

/**
 * The user's answer. A form is accepted with its content, a URL by going to it; a request of the other mode is
 * refused with invalid_elicitation_response.
 */
const sessionElicitationRespondCommandSchema = z.discriminatedUnion("action", [
    z
        .object({
            ...sessionElicitationRespondBase,
            action: z.literal("accept"),
            content: elicitationFormContentSchema,
        })
        .readonly(),
    z.object({ ...sessionElicitationRespondBase, action: z.literal("accept-url") }).readonly(),
    z.object({ ...sessionElicitationRespondBase, action: z.literal("decline") }).readonly(),
    z.object({ ...sessionElicitationRespondBase, action: z.literal("cancel") }).readonly(),
]);

export type SessionElicitationRespondCommand = z.infer<typeof sessionElicitationRespondCommandSchema>;

export const sessionElicitationResolvedEventSchema = z
    .object({
        action: z.enum(["accept", "cancel", "decline", "complete"]),
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_ELICITATION_RESOLVED_KIND),
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionElicitationResolvedEvent = z.infer<typeof sessionElicitationResolvedEventSchema>;

/** Answers one permission or elicitation response request: the Agent received the user's answer. */
const sessionInteractionAnsweredEventSchema = z
    .object({
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_INTERACTION_ANSWERED_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionInteractionAnsweredEvent = z.infer<typeof sessionInteractionAnsweredEventSchema>;

export const decodeSessionPermissionRequestedEvent = (encoded: string): SessionPermissionRequestedEvent =>
    decode(encoded, sessionPermissionRequestedEventSchema);
const decodeSessionPermissionRespondCommand = (encoded: string): SessionPermissionRespondCommand =>
    decode(encoded, sessionPermissionRespondCommandSchema);
export const encodeSessionPermissionRespondCommand = (message: SessionPermissionRespondCommand): string =>
    encode(message, sessionPermissionRespondCommandSchema);
export const decodeSessionElicitationRequestedEvent = (encoded: string): SessionElicitationRequestedEvent =>
    decode(encoded, sessionElicitationRequestedEventSchema);
const decodeSessionElicitationRespondCommand = (encoded: string): SessionElicitationRespondCommand =>
    decode(encoded, sessionElicitationRespondCommandSchema);
export const encodeSessionElicitationRespondCommand = (message: SessionElicitationRespondCommand): string =>
    encode(message, sessionElicitationRespondCommandSchema);
export const decodeSessionInteractionAnsweredEvent = (encoded: string): SessionInteractionAnsweredEvent =>
    decode(encoded, sessionInteractionAnsweredEventSchema);

/** What the Relay answers when it took an answer to one of the Agent's requests. */
const interactionAcceptedSchema = z.object({ accepted: z.literal(true) }).readonly();

export type InteractionAccepted = z.infer<typeof interactionAcceptedSchema>;

export const decodeInteractionAccepted = (value: unknown): InteractionAccepted =>
    decodeZodValue(value, interactionAcceptedSchema);
const sessionElicitationRespondCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_ELICITATION_RESPOND_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
    interactionId: routingIdentifier,
});
const sessionElicitationRespondCommandRoutingSchema = sessionElicitationRespondCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionElicitationRespondCommandRouting = z.infer<typeof sessionElicitationRespondCommandRoutingSchema>;
const decodeSessionElicitationRespondCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionElicitationRespondCommandRoutingSchema);
export const sessionElicitationRespondCommandCodec = encryptedMessageCodec({
    kind: SESSION_ELICITATION_RESPOND_KIND,
    decode: decodeSessionElicitationRespondCommand,
    decodeRouting: decodeSessionElicitationRespondCommandRouting,
    publicRoutingSchema: sessionElicitationRespondCommandPublicRoutingSchema,
});

const sessionPermissionRespondCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_PERMISSION_RESPOND_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
    interactionId: routingIdentifier,
});
const sessionPermissionRespondCommandRoutingSchema = sessionPermissionRespondCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionPermissionRespondCommandRouting = z.infer<typeof sessionPermissionRespondCommandRoutingSchema>;
const decodeSessionPermissionRespondCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionPermissionRespondCommandRoutingSchema);
export const sessionPermissionRespondCommandCodec = encryptedMessageCodec({
    kind: SESSION_PERMISSION_RESPOND_KIND,
    decode: decodeSessionPermissionRespondCommand,
    decodeRouting: decodeSessionPermissionRespondCommandRouting,
    publicRoutingSchema: sessionPermissionRespondCommandPublicRoutingSchema,
});

const sessionInteractionAnsweredEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_INTERACTION_ANSWERED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionInteractionAnsweredEventRoutingSchema = sessionInteractionAnsweredEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export function interactionWireJsonSchemas() {
    return {
        interactionRequest: z.toJSONSchema(
            z.union([sessionElicitationRespondCommandRoutingSchema, sessionPermissionRespondCommandRoutingSchema]),
        ),
        interactionReply: z.toJSONSchema(sessionInteractionAnsweredEventRoutingSchema),
    };
}
export type SessionInteractionAnsweredEventRouting = z.infer<typeof sessionInteractionAnsweredEventRoutingSchema>;
const decodeSessionInteractionAnsweredEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionInteractionAnsweredEventRoutingSchema);
export const sessionInteractionAnsweredEventCodec = encryptedMessageCodec({
    kind: SESSION_INTERACTION_ANSWERED_KIND,
    decode: decodeSessionInteractionAnsweredEvent,
    decodeRouting: decodeSessionInteractionAnsweredEventRouting,
    publicRoutingSchema: sessionInteractionAnsweredEventPublicRoutingSchema,
});
