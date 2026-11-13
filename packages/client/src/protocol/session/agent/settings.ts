import { z } from "zod";

import { DIRECTORY_PATH } from "../../shared/directory.ts";
import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";
import { configValueSchema, SHORT_TEXT } from "../shared/index.ts";

export const AGENT_SETTINGS_DISCOVER_KIND = "agent.settings.discover";
export const AGENT_SETTINGS_DISCOVERED_KIND = "agent.settings.discovered";
export const AGENT_SETTINGS_DISCOVERY_FAILED_KIND = "agent.settings.discovery.failed";

const agentSettingFields = {
    category: z.string().max(128),
    description: SHORT_TEXT,
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(255),
};

/** A setting the Agent offers and its default: a select defaults to one of its values, a boolean to a flag. */
const agentSettingSchema = z.discriminatedUnion("type", [
    z
        .object({
            ...agentSettingFields,
            defaultValue: z.string().max(500),
            type: z.literal("select"),
            values: z.array(configValueSchema).max(500).readonly(),
        })
        .readonly(),
    z.object({ ...agentSettingFields, booleanValue: z.boolean(), type: z.literal("boolean") }).readonly(),
]);

export type AgentSetting = z.infer<typeof agentSettingSchema>;

const agentSettingsSchema = z.array(agentSettingSchema).max(128).readonly();

export const AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE = "complete";
export const AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION = "on_model_selection";
export const AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE = "unavailable";

const agentModelEffortResolutionSchema = z.enum([
    AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE,
    AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
    AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
]);

const agentModelEffortSchema = z
    .object({
        effortSettingId: z.string().max(128),
        modelSettingId: z.string().max(128),
        resolution: agentModelEffortResolutionSchema,
        unsupportedModelIds: z.array(z.string().min(1).max(500)).max(500).readonly(),
        valuesByModel: z.record(z.string().min(1).max(500), z.array(configValueSchema).max(500).readonly()).readonly(),
    })
    .readonly();

export type AgentModelEffort = z.infer<typeof agentModelEffortSchema>;

const agentSettingsDiscoverCommandSchema = z
    .object({
        harness: IDENTIFIER,
        // The directory whose project settings the Agent reads. Omitted means the default directory.
        directory: DIRECTORY_PATH.optional(),
        kind: z.literal(AGENT_SETTINGS_DISCOVER_KIND),
        model: z.string().min(1).max(500).optional(),
        requestId: IDENTIFIER,
    })
    .readonly();

export type AgentSettingsDiscoverCommand = z.infer<typeof agentSettingsDiscoverCommandSchema>;

const agentSettingsDiscoveredEventSchema = z
    .object({
        harness: IDENTIFIER,
        agentName: z.string().max(255),
        agentVersion: z.string().max(128),
        // The directory actually inspected.
        directory: DIRECTORY_PATH,
        kind: z.literal(AGENT_SETTINGS_DISCOVERED_KIND),
        modelEffort: agentModelEffortSchema,
        requestId: IDENTIFIER,
        settings: agentSettingsSchema,
        settingsRevision: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .readonly();

export type AgentSettingsDiscoveredEvent = z.infer<typeof agentSettingsDiscoveredEventSchema>;

const agentSettingsDiscoveryFailedEventSchema = z
    .object({
        code: IDENTIFIER,
        kind: z.literal(AGENT_SETTINGS_DISCOVERY_FAILED_KIND),
        message: z.string().min(1).max(500),
        requestId: IDENTIFIER,
    })
    .readonly();

export type AgentSettingsDiscoveryFailedEvent = z.infer<typeof agentSettingsDiscoveryFailedEventSchema>;

export const decodeAgentSettingsDiscoverCommand = (encoded: string): AgentSettingsDiscoverCommand =>
    decode(encoded, agentSettingsDiscoverCommandSchema);
export const encodeAgentSettingsDiscoverCommand = (message: AgentSettingsDiscoverCommand): string =>
    encode(message, agentSettingsDiscoverCommandSchema);
export const decodeAgentSettingsDiscoveredEvent = (encoded: string): AgentSettingsDiscoveredEvent =>
    decode(encoded, agentSettingsDiscoveredEventSchema);
export const encodeAgentSettingsDiscoveredEvent = (message: AgentSettingsDiscoveredEvent): string =>
    encode(message, agentSettingsDiscoveredEventSchema);
export const decodeAgentSettingsDiscoveryFailedEvent = (encoded: string): AgentSettingsDiscoveryFailedEvent =>
    decode(encoded, agentSettingsDiscoveryFailedEventSchema);
export const encodeAgentSettingsDiscoveryFailedEvent = (message: AgentSettingsDiscoveryFailedEvent): string =>
    encode(message, agentSettingsDiscoveryFailedEventSchema);
