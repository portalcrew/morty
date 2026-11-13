import { createHash } from "node:crypto";
import {
    AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE,
    AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
    AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
    AGENT_SETTINGS_DISCOVERED_KIND,
    type AgentModelEffort,
    type AgentSetting,
    type AgentSettingsDiscoverCommand,
    type AgentSettingsDiscoveredEvent,
    type SessionConfigOption,
    type SessionConfigValue,
} from "@morty-build/client/protocol";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp/acp-error.ts";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import { operationErrorCode } from "../../infra/operation-error.ts";
import type { AgentSettingsModelEffort, ResolveAgent } from "../api/session-api.ts";
import type { SessionManager } from "../manager/session-manager.ts";
import type { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";
import { isModelOption } from "./configuration-dependencies.ts";

/**
 * Correlation details for a settings-discovery failure, safe for the remote diagnostic log. The
 * configuration-value failure carries the requested and offered values itself.
 */
export function agentSettingsFailureDetails(harness: string, failure: unknown): Readonly<Record<string, string>> {
    const details = { harness, code: operationErrorCode(failure) };
    return failure instanceof AcpConfigurationValueUnavailableError
        ? {
              ...details,
              configId: failure.configId,
              offeredValueCount: failure.offeredValueCount.toString(),
              offeredValues: JSON.stringify(failure.offeredValues),
              requestedValue: failure.requestedValue,
          }
        : details;
}

export interface AgentSettingsDiscovery {
    readonly event: AgentSettingsDiscoveredEvent;
    readonly unsupportedModels: readonly AcpConfigurationValueUnavailableError[];
}

function isUnavailableModel(
    cause: unknown,
    modelSettingId: string,
    requestedModel: string,
): cause is AcpConfigurationValueUnavailableError {
    return (
        cause instanceof AcpConfigurationValueUnavailableError &&
        cause.configId === modelSettingId &&
        cause.requestedValue === requestedModel
    );
}

function unsupportedModelIds(unsupportedModels: readonly AcpConfigurationValueUnavailableError[]): readonly string[] {
    return [...new Set(unsupportedModels.map((item) => item.requestedValue))];
}

export async function discoverAgentSettings(
    command: AgentSettingsDiscoverCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    signal: AbortSignal,
): Promise<AgentSettingsDiscovery> {
    const { agent, adapter: harnessAdapter } = await resolveAgent(command.harness, signal);
    // The Agent reads project settings from the directory a Session starts in, so the defaults it reports are those
    // of the requested directory.
    const directory = command.directory ?? ".";
    const cwd = await directories.resolve(directory, signal);
    const inspectedBaseSnapshot = await sessions.inspectAgentSettings({
        adapter: harnessAdapter,
        agent,
        cwd,
        signal,
    });
    const baseSnapshot = {
        agentName: inspectedBaseSnapshot.agentName,
        agentVersion: inspectedBaseSnapshot.agentVersion,
        configOptions: inspectedBaseSnapshot.configOptions,
        modelEffort: inspectedBaseSnapshot.modelEffort,
    };
    const baseModel = modelOption(baseSnapshot.configOptions);
    const unsupportedModels: AcpConfigurationValueUnavailableError[] = [];
    let selectedSnapshot = baseSnapshot;
    if (command.model !== undefined) {
        if (
            baseModel === undefined ||
            baseModel.type !== "select" ||
            !baseModel.values.some((value) => value.value === command.model)
        ) {
            unsupportedModels.push(
                new AcpConfigurationValueUnavailableError(
                    baseModel?.id ?? "model",
                    command.model,
                    baseModel?.type === "select" ? baseModel.values.map((value) => value.value) : [],
                ),
            );
        } else {
            try {
                selectedSnapshot = await sessions.inspectAgentSettings({
                    adapter: harnessAdapter,
                    agent,
                    cwd,
                    model: command.model,
                    signal,
                });
            } catch (cause) {
                signal.throwIfAborted();
                if (!isUnavailableModel(cause, baseModel.id, command.model)) {
                    throw cause;
                }
                unsupportedModels.push(cause);
            }
        }
    }
    const modelEffort = await discoverModelEffort(
        command,
        agent,
        harnessAdapter,
        agent.harness === "codex"
            ? AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE
            : AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION,
        baseSnapshot.configOptions,
        selectedSnapshot.configOptions,
        unsupportedModels,
        baseSnapshot.modelEffort,
        cwd,
        sessions,
        signal,
    );
    const baseSettings = withoutUnsupportedModels(
        settingsFromSnapshot(baseSnapshot.configOptions),
        baseModel?.id ?? "",
        modelEffort.unsupportedModelIds,
    );
    const settings = withoutUnsupportedModels(
        settingsFromSnapshot(selectedSnapshot.configOptions),
        baseModel?.id ?? "",
        modelEffort.unsupportedModelIds,
    );
    return {
        event: {
            harness: command.harness,
            agentName: selectedSnapshot.agentName,
            agentVersion: selectedSnapshot.agentVersion,
            directory,
            kind: AGENT_SETTINGS_DISCOVERED_KIND,
            modelEffort,
            requestId: command.requestId,
            settings,
            settingsRevision: settingsRevision(agent, baseSnapshot.agentVersion, baseSettings, modelEffort),
        },
        unsupportedModels,
    };
}

function settingFromOption(option: SessionConfigOption): AgentSetting {
    const { category, description, id, name } = option;
    return option.type === "boolean"
        ? { booleanValue: option.booleanValue, category, description, id, name, type: "boolean" }
        : { category, defaultValue: option.currentValue, description, id, name, type: "select", values: option.values };
}

function settingsFromSnapshot(configOptions: readonly SessionConfigOption[]): readonly AgentSetting[] {
    const settings = configOptions.map(settingFromOption);
    const identifiers = new Set<string>();
    for (const setting of settings) {
        if (identifiers.has(setting.id)) {
            throw new AcpExecutionError(
                "The Agent returned duplicate setting identifiers",
                {},
                "invalid_session_configuration",
            );
        }
        identifiers.add(setting.id);
    }
    if (settings.length > 128) {
        throw new AcpExecutionError("The Agent returned too many settings", {}, "invalid_session_configuration");
    }
    return settings;
}

function withoutUnsupportedModels(
    settings: readonly AgentSetting[],
    modelSettingId: string,
    unsupportedModelIds: readonly string[],
): readonly AgentSetting[] {
    if (modelSettingId.length === 0 || unsupportedModelIds.length === 0) {
        return settings;
    }
    const unsupported = new Set(unsupportedModelIds);
    return settings.map((setting) => {
        if (setting.id !== modelSettingId || setting.type !== "select") {
            return setting;
        }
        return {
            ...setting,
            defaultValue: unsupported.has(setting.defaultValue) ? "" : setting.defaultValue,
            values: setting.values.filter((value) => !unsupported.has(value.value)),
        };
    });
}

function modelOption(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
    return options.find(isModelOption);
}

function effortOption(options: readonly SessionConfigOption[]): SessionConfigOption | undefined {
    return options.find((option) => option.id === "reasoning_effort" || option.category === "thought_level");
}

function unavailableModelEffort(): AgentModelEffort {
    return {
        effortSettingId: "",
        modelSettingId: "",
        resolution: AGENT_MODEL_EFFORT_RESOLUTION_UNAVAILABLE,
        unsupportedModelIds: [],
        valuesByModel: {},
    };
}

async function discoverModelEffort(
    command: AgentSettingsDiscoverCommand,
    agent: AcpAgentDefinition,
    harnessAdapter: Awaited<ReturnType<ResolveAgent>>["adapter"],
    resolution: string,
    initialOptions: readonly SessionConfigOption[],
    selectedOptions: readonly SessionConfigOption[],
    initiallyUnsupportedModels: AcpConfigurationValueUnavailableError[],
    discoveredModelEffort: AgentSettingsModelEffort,
    cwd: string,
    sessions: SessionManager,
    signal: AbortSignal,
): Promise<AgentModelEffort> {
    const model = modelOption(initialOptions);
    const unsupportedModels = initiallyUnsupportedModels;
    if (
        resolution !== AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE &&
        resolution !== AGENT_MODEL_EFFORT_RESOLUTION_ON_MODEL_SELECTION
    ) {
        return { ...unavailableModelEffort(), unsupportedModelIds: unsupportedModelIds(unsupportedModels) };
    }
    if (model === undefined || model.type !== "select" || model.values.length === 0) {
        return { ...unavailableModelEffort(), unsupportedModelIds: unsupportedModelIds(unsupportedModels) };
    }
    if (
        resolution === AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE &&
        discoveredModelEffort.kind === "complete" &&
        discoveredModelEffort.value.resolution === AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE
    ) {
        return discoveredModelEffort.value;
    }
    const inspectModel = async (modelValue: string): Promise<readonly SessionConfigOption[]> =>
        (
            await sessions.inspectAgentSettings({
                adapter: harnessAdapter,
                agent,
                cwd,
                model: modelValue,
                signal,
            })
        ).configOptions;
    const valuesByModel: Record<string, readonly SessionConfigValue[]> = {};
    if (resolution === "complete") {
        const effort = effortOption(initialOptions);
        if (effort === undefined || effort.type !== "select" || effort.values.length < 2) {
            return {
                ...unavailableModelEffort(),
                unsupportedModelIds: unsupportedModelIds(unsupportedModels),
            };
        }
        for (const value of model.values) {
            if (unsupportedModels.some((diagnostic) => diagnostic.requestedValue === value.value)) {
                continue;
            }
            try {
                const selectedEffort = effortOption(await inspectModel(value.value));
                valuesByModel[value.value] = selectedEffort?.type === "select" ? selectedEffort.values : [];
            } catch (cause) {
                signal.throwIfAborted();
                if (!isUnavailableModel(cause, model.id, value.value)) {
                    throw cause;
                }
                unsupportedModels.push(cause);
            }
        }
        return {
            effortSettingId: effort.id,
            modelSettingId: model.id,
            resolution: "complete",
            unsupportedModelIds: unsupportedModelIds(unsupportedModels),
            valuesByModel,
        };
    }
    if (command.model !== undefined) {
        const modelUnsupported = unsupportedModels.some((diagnostic) => diagnostic.requestedValue === command.model);
        const selectedEffort = effortOption(selectedOptions);
        if (!modelUnsupported) {
            valuesByModel[command.model] = selectedEffort?.type === "select" ? selectedEffort.values : [];
        }
        return {
            effortSettingId: selectedEffort?.id ?? "",
            modelSettingId: model.id,
            resolution: "on_model_selection",
            unsupportedModelIds: unsupportedModelIds(unsupportedModels),
            valuesByModel,
        };
    }
    // No model was named, so the Agent answered about its own default model — one
    // whose effort option an Agent may withhold. Resolve that model's capability
    // too, or a session that never switches models can never offer an effort.
    const defaultModel = model.type === "select" ? model.currentValue : "";
    const reportedEffort = effortOption(selectedOptions);
    let selectedEffort = reportedEffort;
    if (defaultModel.length > 0 && reportedEffort === undefined) {
        try {
            selectedEffort = effortOption(await inspectModel(defaultModel));
        } catch (cause) {
            signal.throwIfAborted();
            if (!isUnavailableModel(cause, model.id, defaultModel)) {
                throw cause;
            }
            unsupportedModels.push(cause);
        }
    }
    if (
        defaultModel.length > 0 &&
        !unsupportedModels.some((diagnostic) => diagnostic.requestedValue === defaultModel)
    ) {
        valuesByModel[defaultModel] = selectedEffort?.type === "select" ? selectedEffort.values : [];
    }
    return {
        effortSettingId: selectedEffort?.id ?? "",
        modelSettingId: model.id,
        resolution: "on_model_selection",
        unsupportedModelIds: unsupportedModelIds(unsupportedModels),
        valuesByModel,
    };
}

function settingsRevision(
    agent: AcpAgentDefinition,
    reportedAgentVersion: string,
    settings: readonly AgentSetting[],
    modelEffort: AgentModelEffort,
): string {
    // A dynamic effort lookup adds one model's settings and values to an
    // otherwise stable Agent capability document. It must not look like the
    // Agent's settings changed each time a caller switches models.
    const revisionModelEffort =
        modelEffort.resolution === AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE
            ? modelEffort
            : {
                  effortSettingId: "",
                  modelSettingId: modelEffort.modelSettingId,
                  resolution: modelEffort.resolution,
                  unsupportedModelIds: modelEffort.unsupportedModelIds,
                  valuesByModel: {},
              };
    return createHash("sha256")
        .update(
            JSON.stringify({
                harness: agent.harness,
                agentVersion: agent.agentVersion,
                modelEffort: revisionModelEffort,
                reportedAgentVersion,
                settings,
            }),
        )
        .digest("hex");
}
