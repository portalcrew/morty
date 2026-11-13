import { z } from "zod";
import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, decodeZodValue, encodeZodMessage as encode } from "../../shared/message-codec.ts";
import { boundedJsonSchema, toolCallLocationSchema } from "../../shared/tool-input.ts";
import { SHORT_TEXT } from "../shared/index.ts";
import { nativeSessionTargetSchema } from "../shared/native-session-target.ts";

export const SESSION_PERMISSION_REQUESTED_KIND = "session.permission.requested";
export const SESSION_PERMISSION_RESPOND_KIND = "session.permission.respond";
export const SESSION_PERMISSION_RESOLVED_KIND = "session.permission.resolved";
export const SESSION_ELICITATION_REQUESTED_KIND = "session.elicitation.requested";
export const SESSION_ELICITATION_RESPOND_KIND = "session.elicitation.respond";
export const SESSION_ELICITATION_RESOLVED_KIND = "session.elicitation.resolved";
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

const elicitationFieldSchema = z
    .object({
        defaultBooleanValue: z.boolean(),
        defaultNumberValue: z.number().finite(),
        defaultStringValue: z.string().max(10_000),
        description: SHORT_TEXT,
        format: z.string().max(64),
        hasDefaultValue: z.boolean(),
        maximum: z.string().max(128),
        maximumLength: z.string().max(128),
        minimum: z.string().max(128),
        minimumLength: z.string().max(128),
        multiline: z.boolean().optional(),
        name: z.string().min(1).max(128),
        options: z.array(elicitationOptionSchema).max(200).readonly(),
        pattern: z.string().max(500),
        required: z.boolean(),
        title: z.string().min(1).max(255),
        type: z.enum(["boolean", "integer", "multiselect", "number", "select", "string"]),
    })
    .readonly();

export type SessionElicitationField = z.infer<typeof elicitationFieldSchema>;

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

const sessionPermissionRespondCommandSchema = z
    .object({
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_PERMISSION_RESPOND_KIND),
        optionId: z.string().max(255),
        outcome: z.enum(["cancelled", "selected"]),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

/**
 * Repeating the same answer succeeds within the live Session's last 256 answered permissions. A different
 * answer returns permission_response_conflict. An unavailable request is never inferred to have succeeded;
 * reconnecting clients reconcile the current interaction snapshot before offering another answer.
 */
export type SessionPermissionRespondCommand = z.infer<typeof sessionPermissionRespondCommandSchema>;

export const sessionPermissionResolvedEventSchema = z
    .object({
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_PERMISSION_RESOLVED_KIND),
        optionId: z.string().max(255),
        outcome: z.enum(["cancelled", "selected"]),
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionPermissionResolvedEvent = z.infer<typeof sessionPermissionResolvedEventSchema>;

export const sessionElicitationRequestedEventSchema = z
    .object({
        accepted: z.boolean(),
        commandId: IDENTIFIER,
        elicitationId: z.string().max(255),
        fields: z.array(elicitationFieldSchema).max(100).readonly(),
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_ELICITATION_REQUESTED_KIND),
        message: z.string().min(1).max(2_000),
        mode: z.enum(["form", "url"]),
        target: nativeSessionTargetSchema,
        url: z.string().max(4_096),
    })
    .readonly();

export type SessionElicitationRequestedEvent = z.infer<typeof sessionElicitationRequestedEventSchema>;

const sessionElicitationRespondCommandSchema = z
    .object({
        action: z.enum(["accept", "cancel", "decline"]),
        content: z.string().max(100_000),
        interactionId: IDENTIFIER,
        kind: z.literal(SESSION_ELICITATION_RESPOND_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

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
export const decodeSessionPermissionRespondCommand = (encoded: string): SessionPermissionRespondCommand =>
    decode(encoded, sessionPermissionRespondCommandSchema);
export const encodeSessionPermissionRespondCommand = (message: SessionPermissionRespondCommand): string =>
    encode(message, sessionPermissionRespondCommandSchema);
export const decodeSessionElicitationRequestedEvent = (encoded: string): SessionElicitationRequestedEvent =>
    decode(encoded, sessionElicitationRequestedEventSchema);
export const decodeSessionElicitationRespondCommand = (encoded: string): SessionElicitationRespondCommand =>
    decode(encoded, sessionElicitationRespondCommandSchema);
export const encodeSessionElicitationRespondCommand = (message: SessionElicitationRespondCommand): string =>
    encode(message, sessionElicitationRespondCommandSchema);
export const decodeSessionInteractionAnsweredEvent = (encoded: string): SessionInteractionAnsweredEvent =>
    decode(encoded, sessionInteractionAnsweredEventSchema);
export const encodeSessionInteractionAnsweredEvent = (message: SessionInteractionAnsweredEvent): string =>
    encode(message, sessionInteractionAnsweredEventSchema);

/** What the Relay answers when it took an answer to one of the Agent's requests. */
const interactionAcceptedSchema = z.object({ accepted: z.literal(true) }).readonly();

export type InteractionAccepted = z.infer<typeof interactionAcceptedSchema>;

export const decodeInteractionAccepted = (value: unknown): InteractionAccepted =>
    decodeZodValue(value, interactionAcceptedSchema);
