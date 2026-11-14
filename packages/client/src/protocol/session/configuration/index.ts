import { z } from "zod";
import { encryptedMessageCodec } from "../../shared/encrypted-message.ts";
import {
    identifierStringSchema as IDENTIFIER,
    identifierStringSchema as routingIdentifier,
} from "../../shared/identifier.ts";
import {
    decodeZodMessage as decodeRoutingZodMessage,
    decodeZodMessage,
    decodeZodValue,
    encodeZodMessage,
    encryptedFieldSchema,
} from "../../shared/message-codec.ts";
import { configValueSchema, SHORT_TEXT } from "../shared/index.ts";
import {
    nativeSessionTargetSchema,
    nativeSessionTargetSchema as routingTarget,
} from "../shared/native-session-target.ts";

export const SESSION_CONFIGURE_KIND = "session.configure";
export const SESSION_CONFIG_UPDATED_KIND = "session.config.updated";

const sessionConfigOptionFields = {
    category: z.string().max(128),
    description: SHORT_TEXT,
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(255),
};

/** A setting the Agent offers and what it holds now: a select holds one of its values, a boolean holds a flag. */
const sessionConfigOptionSchema = z.discriminatedUnion("type", [
    z
        .object({
            ...sessionConfigOptionFields,
            currentValue: z.string().max(500),
            type: z.literal("select"),
            values: z.array(configValueSchema).max(500).readonly(),
        })
        .readonly(),
    z.object({ ...sessionConfigOptionFields, booleanValue: z.boolean(), type: z.literal("boolean") }).readonly(),
]);

export type SessionConfigOption = z.infer<typeof sessionConfigOptionSchema>;

export const sessionConfigOptionsSchema = z.array(sessionConfigOptionSchema).max(100).readonly();

/** One setting's chosen value: a select takes a value, a boolean takes a flag, and each carries only its own. */
const sessionConfigurationSelectionSchema = z.discriminatedUnion("type", [
    z.object({ configId: IDENTIFIER, type: z.literal("select"), value: z.string().max(500) }).readonly(),
    z.object({ booleanValue: z.boolean(), configId: IDENTIFIER, type: z.literal("boolean") }).readonly(),
]);

export type SessionConfigurationSelection = z.infer<typeof sessionConfigurationSelectionSchema>;

export const sessionConfigurationSelectionsSchema = z
    .array(sessionConfigurationSelectionSchema)
    .max(100)
    .superRefine((selections, context) => {
        const identifiers = new Set<string>();
        for (const [index, selection] of selections.entries()) {
            if (identifiers.has(selection.configId)) {
                context.addIssue({
                    code: "custom",
                    message: "Session configuration identifiers must be unique",
                    path: [index, "configId"],
                });
            }
            identifiers.add(selection.configId);
        }
    })
    .readonly();

const sessionConfigureCommandFields = {
    configId: z.string().min(1).max(128),
    expectedConfigurationRevision: IDENTIFIER,
    kind: z.literal(SESSION_CONFIGURE_KIND),
    requestId: IDENTIFIER,
    target: nativeSessionTargetSchema,
};

const sessionConfigureCommandSchema = z.discriminatedUnion("type", [
    z.object({ ...sessionConfigureCommandFields, type: z.literal("select"), value: z.string().max(500) }).readonly(),
    z.object({ ...sessionConfigureCommandFields, booleanValue: z.boolean(), type: z.literal("boolean") }).readonly(),
]);

export type SessionConfigureCommand = z.infer<typeof sessionConfigureCommandSchema>;

const sessionConfigUpdatedEventSchema = z
    .object({
        configOptions: sessionConfigOptionsSchema,
        // An opaque Computer generation token.
        configurationRevision: IDENTIFIER,
        kind: z.literal(SESSION_CONFIG_UPDATED_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionConfigUpdatedEvent = z.infer<typeof sessionConfigUpdatedEventSchema>;

export const decodeSessionConfigurationSelections = (value: unknown): readonly SessionConfigurationSelection[] =>
    decodeZodValue(value, sessionConfigurationSelectionsSchema);

/** The setting change a configure command asks for, without the command's addressing. */
export const sessionConfigurationSelection = (command: SessionConfigureCommand): SessionConfigurationSelection =>
    command.type === "boolean"
        ? { booleanValue: command.booleanValue, configId: command.configId, type: "boolean" }
        : { configId: command.configId, type: "select", value: command.value };

const decodeSessionConfigureCommand = (encoded: string): SessionConfigureCommand =>
    decodeZodMessage(encoded, sessionConfigureCommandSchema);
export const encodeSessionConfigureCommand = (message: SessionConfigureCommand): string =>
    encodeZodMessage(message, sessionConfigureCommandSchema);
export const decodeSessionConfigUpdatedEvent = (encoded: string): SessionConfigUpdatedEvent =>
    decodeZodMessage(encoded, sessionConfigUpdatedEventSchema);

export const SESSION_CONFIG_READ_KIND = "session.config.read";
export const SESSION_CONFIG_READ_RESULT_KIND = "session.config.read.result";

const sessionConfigReadCommandSchema = z
    .object({
        kind: z.literal(SESSION_CONFIG_READ_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionConfigReadCommand = z.infer<typeof sessionConfigReadCommandSchema>;

const sessionConfigReadResultSchema = z
    .object({
        configOptions: sessionConfigOptionsSchema,
        // An opaque Computer generation token.
        configurationRevision: IDENTIFIER,
        kind: z.literal(SESSION_CONFIG_READ_RESULT_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionConfigReadResult = z.infer<typeof sessionConfigReadResultSchema>;

const decodeSessionConfigReadCommand = (encoded: string): SessionConfigReadCommand =>
    decodeZodMessage(encoded, sessionConfigReadCommandSchema);
export const encodeSessionConfigReadCommand = (message: SessionConfigReadCommand): string =>
    encodeZodMessage(message, sessionConfigReadCommandSchema);
export const decodeSessionConfigReadResult = (encoded: string): SessionConfigReadResult =>
    decodeZodMessage(encoded, sessionConfigReadResultSchema);

const sessionConfigureCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_CONFIGURE_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionConfigureCommandRoutingSchema = sessionConfigureCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionConfigureCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionConfigureCommandRoutingSchema);
export const sessionConfigureCommandCodec = encryptedMessageCodec({
    kind: SESSION_CONFIGURE_KIND,
    decode: decodeSessionConfigureCommand,
    decodeRouting: decodeSessionConfigureCommandRouting,
    publicRoutingSchema: sessionConfigureCommandPublicRoutingSchema,
});

const sessionConfigReadCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_CONFIG_READ_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionConfigReadCommandRoutingSchema = sessionConfigReadCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionConfigReadCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionConfigReadCommandRoutingSchema);
export const sessionConfigReadCommandCodec = encryptedMessageCodec({
    kind: SESSION_CONFIG_READ_KIND,
    decode: decodeSessionConfigReadCommand,
    decodeRouting: decodeSessionConfigReadCommandRouting,
    publicRoutingSchema: sessionConfigReadCommandPublicRoutingSchema,
});

const sessionConfigUpdatedEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_CONFIG_UPDATED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionConfigUpdatedEventRoutingSchema = sessionConfigUpdatedEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionConfigUpdatedEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionConfigUpdatedEventRoutingSchema);
export const sessionConfigUpdatedEventCodec = encryptedMessageCodec({
    kind: SESSION_CONFIG_UPDATED_KIND,
    decode: decodeSessionConfigUpdatedEvent,
    decodeRouting: decodeSessionConfigUpdatedEventRouting,
    publicRoutingSchema: sessionConfigUpdatedEventPublicRoutingSchema,
});

const sessionConfigReadResultPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_CONFIG_READ_RESULT_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionConfigReadResultRoutingSchema = sessionConfigReadResultPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export function configurationWireJsonSchemas() {
    return {
        configurationRequest: z.toJSONSchema(sessionConfigReadCommandRoutingSchema),
        configureRequest: z.toJSONSchema(sessionConfigureCommandRoutingSchema),
        configurationReply: z.toJSONSchema(sessionConfigReadResultRoutingSchema),
        configuredReply: z.toJSONSchema(sessionConfigUpdatedEventRoutingSchema),
    };
}
const decodeSessionConfigReadResultRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionConfigReadResultRoutingSchema);
export const sessionConfigReadResultCodec = encryptedMessageCodec({
    kind: SESSION_CONFIG_READ_RESULT_KIND,
    decode: decodeSessionConfigReadResult,
    decodeRouting: decodeSessionConfigReadResultRouting,
    publicRoutingSchema: sessionConfigReadResultPublicRoutingSchema,
});
