import type { SessionConfigValue } from "@morty-build/client/protocol";

export const AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE = "complete";
export const AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION = "on_model_selection";
export const AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE = "unavailable";

/**
 * What the Runtime learns about each model's effort choices while it discovers an Agent's settings, and which models
 * the Agent cannot switch to. Only the models it can switch to reach the settings clients read.
 */
export interface AgentModelEffort {
    readonly effortSettingId: string;
    readonly modelSettingId: string;
    readonly resolution:
        | typeof AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE
        | typeof AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION
        | typeof AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE;
    readonly unsupportedModelIds: readonly string[];
    readonly valuesByModel: Readonly<Record<string, readonly SessionConfigValue[]>>;
}
