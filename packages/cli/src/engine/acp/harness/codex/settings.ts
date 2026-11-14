import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import { AcpExecutionError } from "../../acp-error.ts";
import { AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE, type AgentModelEffort } from "../../agent/model-effort.ts";
import type { CodexAppServerClient } from "./app-server-client.ts";
import { type CodexModel, modelListResponseSchema } from "./app-server-protocol.ts";

const APPROVAL_TIMEOUT_MILLISECONDS = 3_600_000;
// Public ACP configuration identifiers.
const MODEL_SETTING_ID = "model";
const REASONING_EFFORT_SETTING_ID = "reasoning_effort";
const MODE_SETTING_ID = "mode";
const FAST_MODE_SETTING_ID = "fast-mode";
const COLLABORATION_MODE_SETTING_ID = "collaboration_mode";
const MODEL_CATALOG_LIMIT = 1_000;
// `additionalSpeedTiers` and `serviceTier` are two vocabularies for one concept: a model advertises
// "fast" while the thread reports the resolved tier as "priority". Fast mode is offered per model,
// because most models have no speed tier at all.
const FAST_TIER = "fast";
const SERVICE_TIER_FAST = "priority";
interface AgentMode {
    readonly approvalsReviewer: string;
    readonly approvalPolicy: string;
    readonly description: string;
    readonly id: string;
    readonly name: string;
    readonly sandboxPolicy: Readonly<Record<string, unknown>>;
}

const WORKSPACE_WRITE_POLICY: Readonly<Record<string, unknown>> = Object.freeze({
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
    networkAccess: false,
    type: "workspaceWrite",
    writableRoots: [],
});

/** Each approval preset carries its complete sandbox and approval policy. */
const READ_ONLY_MODE: AgentMode = Object.freeze({
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    description: "Always ask to edit external files and use the internet",
    id: "read-only",
    name: "Ask for approval",
    sandboxPolicy: WORKSPACE_WRITE_POLICY,
});
const AGENT_MODE: AgentMode = Object.freeze({
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    description: "Only ask for actions detected as potentially unsafe",
    id: "agent",
    name: "Approve for me",
    sandboxPolicy: WORKSPACE_WRITE_POLICY,
});
const FULL_ACCESS_MODE: AgentMode = Object.freeze({
    approvalPolicy: "never",
    approvalsReviewer: "user",
    description: "Unrestricted access to the internet and any file on your computer",
    id: "agent-full-access",
    name: "Full access",
    sandboxPolicy: { type: "dangerFullAccess" },
});

const AGENT_MODES: readonly AgentMode[] = Object.freeze([READ_ONLY_MODE, AGENT_MODE, FULL_ACCESS_MODE]);
const DEFAULT_MODE = FULL_ACCESS_MODE;

function capitalize(value: string): string {
    return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The model and reasoning effort this session runs with. Codex reports the pair it resolved from its
 * own configuration on `thread/start`; a `session/set_config_option` replaces either half. Both are
 * sent on `turn/start`, which is how Codex applies them to the turn being started.
 */
interface SessionSelection {
    readonly collaborationMode: string;
    readonly effort: string;
    readonly fastMode: boolean;
    readonly mode: string;
    readonly model: string;
}

interface ConfigValue {
    readonly description: string;
    readonly name: string;
    readonly value: string;
}

function modelValues(models: readonly CodexModel[]): ConfigValue[] {
    return models.map((model) => ({
        description: model.description ?? "",
        name: model.displayName ?? model.id,
        value: model.id,
    }));
}

function effortValues(model: CodexModel | undefined): ConfigValue[] {
    return (model?.supportedReasoningEfforts ?? []).map((option) => ({
        description: option.description ?? "",
        name: capitalize(option.reasoningEffort),
        value: option.reasoningEffort,
    }));
}

function supportedSelection(models: readonly CodexModel[], reportedModel: string, reportedEffort: string) {
    const model = models.find((candidate) => candidate.id === reportedModel);
    if (model === undefined) {
        return { model: reportedModel, effort: reportedEffort };
    }
    const efforts = model.supportedReasoningEfforts ?? [];
    return {
        model: model.id,
        effort: efforts.some((candidate) => candidate.reasoningEffort === reportedEffort)
            ? reportedEffort
            : (model.defaultReasoningEffort ?? efforts[0]?.reasoningEffort ?? ""),
    };
}

function modelSetting(models: readonly CodexModel[], currentValue: string): SessionConfigOption | null {
    const catalogValues = modelValues(models);
    const values =
        currentValue.length > 0 && !catalogValues.some((value) => value.value === currentValue)
            ? [
                  { description: "Current model configured in Codex", name: currentValue, value: currentValue },
                  ...catalogValues,
              ]
            : catalogValues;
    const current = values.some((value) => value.value === currentValue)
        ? currentValue
        : (models.find((model) => model.isDefault === true)?.id ?? values[0]?.value ?? "");
    if (current.length === 0) {
        return null;
    }
    return {
        category: "model",
        currentValue: current,
        description: "Model Codex uses for the session",
        id: MODEL_SETTING_ID,
        name: "Model",
        options: values,
        type: "select",
    };
}

function modeSetting(currentValue: string): SessionConfigOption {
    return {
        category: "mode",
        currentValue,
        description: "Approval and sandboxing preset for the session",
        id: MODE_SETTING_ID,
        name: "Mode",
        options: AGENT_MODES.map((mode) => ({
            description: mode.description,
            name: mode.name,
            value: mode.id,
        })),
        type: "select",
    };
}

/** Build and Plan choices for subsequent turns. */
const COLLABORATION_MODES: readonly ConfigValue[] = Object.freeze([
    { description: "Codex answers and makes changes directly", name: "Build", value: "default" },
    { description: "Codex plans before making changes", name: "Plan", value: "plan" },
]);

function collaborationModeSetting(currentValue: string): SessionConfigOption {
    const current = COLLABORATION_MODES.some((mode) => mode.value === currentValue)
        ? currentValue
        : (COLLABORATION_MODES[0]?.value ?? "default");
    return {
        category: "collaboration_mode",
        currentValue: current,
        description: "How Codex collaborates for subsequent turns",
        id: COLLABORATION_MODE_SETTING_ID,
        name: "Collaboration mode",
        options: [...COLLABORATION_MODES],
        type: "select",
    };
}

/** Offer fast mode only for models that advertise a speed tier. */
function fastModeSetting(model: CodexModel | undefined, enabled: boolean): SessionConfigOption | null {
    if (model?.additionalSpeedTiers?.includes(FAST_TIER) !== true) {
        return null;
    }
    return {
        category: "model_config",
        currentValue: enabled,
        description: "1.5x speed, increased usage",
        id: FAST_MODE_SETTING_ID,
        name: "Fast mode",
        type: "boolean",
    };
}

function effortSetting(model: CodexModel | undefined, currentValue: string): SessionConfigOption | null {
    const values = effortValues(model);
    if (values.length === 0) {
        return null;
    }
    const current = values.some((value) => value.value === currentValue) ? currentValue : (values[0]?.value ?? "");
    if (current.length === 0) {
        return null;
    }
    return {
        category: "thought_level",
        currentValue: current,
        description: "How much reasoning effort the model should use",
        id: REASONING_EFFORT_SETTING_ID,
        name: "Reasoning effort",
        options: values,
        type: "select",
    };
}

export class CodexSettings {
    readonly #appServer: CodexAppServerClient;
    #models: readonly CodexModel[] = [];
    // Whether a collaboration mode choice has been made in this session. A restored thread keeps
    // the mode Codex already persisted, so the first turn does not reset it to Build.
    #collaborationModeSelected = false;
    // Whether the app-server accepts collaboration mode on `turn/start`, probed once per
    // app-server. An older Codex rejects the experimental field, and the setting must disappear
    // rather than break every turn.
    #collaborationModeSupported: boolean | null = null;
    #selection: SessionSelection;

    constructor(appServer: CodexAppServerClient) {
        this.#appServer = appServer;
        this.#selection = {
            collaborationMode: "default",
            effort: "",
            fastMode: false,
            mode: DEFAULT_MODE.id,
            model: "",
        };
    }
    readonly selectNewThread = (created: {
        readonly model?: string | null | undefined;
        readonly reasoningEffort?: string | null | undefined;
    }): void => {
        // A new thread always starts in the default mode, so only the model and effort come
        // from Codex. The mode is re-applied on the first turn.
        const supported = supportedSelection(this.#models, created.model ?? "", created.reasoningEffort ?? "");
        this.#selection = {
            ...this.#selection,
            collaborationMode: "default",
            ...supported,
        };
        this.#collaborationModeSelected = false;
    };
    readonly observeCollaborationMode = (mode: string | undefined): boolean => {
        if (mode === undefined || mode === this.#selection.collaborationMode) {
            return false;
        }
        this.#selection = { ...this.#selection, collaborationMode: mode };
        return true;
    };
    readonly turnParameters = (): Readonly<Record<string, unknown>> => {
        const selection = this.#selection;
        const mode = AGENT_MODES.find((candidate) => candidate.id === selection.mode) ?? DEFAULT_MODE;
        const model = this.#model(selection.model);
        const supportsFast = model?.additionalSpeedTiers?.includes(FAST_TIER) === true;
        return {
            approvalPolicy: mode.approvalPolicy,
            approvalsReviewer: mode.approvalsReviewer,
            sandboxPolicy: mode.sandboxPolicy,
            // Codex only streams its provider-authored reasoning summary when the turn opts in.
            // Keep the summary channel enabled so Thinking has visible content even when no raw
            // reasoning text is available.
            summary: "auto",
            // The collaboration mode rides on the turn: Codex applies it to the
            // thread, where it persists until changed. "Build" is Codex's `default`
            // mode, so it is only sent once a choice exists to apply.
            ...(this.#collaborationModeSupported &&
            (selection.collaborationMode !== "default" || this.#collaborationModeSelected)
                ? {
                      collaborationMode: {
                          mode: selection.collaborationMode,
                          settings: {
                              developer_instructions: null,
                              model: selection.model,
                              reasoning_effort: selection.effort.length === 0 ? null : selection.effort,
                          },
                      },
                  }
                : {}),
            ...(model === undefined || selection.effort.length === 0 ? {} : { effort: selection.effort }),
            ...(model === undefined ? {} : { model: model.id }),
            ...(selection.fastMode && supportsFast ? { serviceTier: SERVICE_TIER_FAST } : {}),
        };
    };
    readonly loadModels = async (signal: AbortSignal): Promise<void> => {
        const models: CodexModel[] = [];
        let cursor: string | null = null;
        try {
            do {
                const decoded = modelListResponseSchema.parse(
                    await this.#appServer.request(
                        "model/list",
                        { cursor, limit: null },
                        AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
                models.push(...decoded.data);
                cursor = decoded.nextCursor ?? null;
            } while (cursor !== null && models.length < MODEL_CATALOG_LIMIT);
        } catch (error) {
            signal.throwIfAborted();
            process.stderr.write(`[codex-acp] model catalog unavailable: ${String(error)}\n`);
        }
        this.#models = Object.freeze(models.slice(0, MODEL_CATALOG_LIMIT));
    };

    readonly #model = (id: string): CodexModel | undefined => this.#models.find((model) => model.id === id);

    /**
     * Learns, once per app-server, whether collaboration mode can be applied. An empty settings
     * update is a no-op on a supporting Codex; an older Codex answers an error, which costs the
     * Build/Plan selector alone without changing a restored thread's persisted mode.
     */
    readonly probeCollaborationMode = async (threadId: string, signal: AbortSignal): Promise<void> => {
        if (this.#collaborationModeSupported !== null) {
            return;
        }
        try {
            await this.#appServer.request(
                "thread/settings/update",
                { threadId },
                AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
            );
            this.#collaborationModeSupported = true;
        } catch {
            signal.throwIfAborted();
            this.#collaborationModeSupported = false;
        }
    };

    /** The ACP settings Morty discovers and renders in Run settings. */
    readonly configOptions = (): SessionConfigOption[] => {
        const options: SessionConfigOption[] = [];
        const model = modelSetting(this.#models, this.#selection.model);
        if (model !== null) {
            options.push(model);
        }
        const effort = effortSetting(this.#model(this.#selection.model), this.#selection.effort);
        if (effort !== null) {
            options.push(effort);
        }
        const fastMode = fastModeSetting(this.#model(this.#selection.model), this.#selection.fastMode);
        if (fastMode !== null) {
            options.push(fastMode);
        }
        if (this.#collaborationModeSupported === true) {
            options.push(collaborationModeSetting(this.#selection.collaborationMode));
        }
        options.push(modeSetting(this.#selection.mode));
        return options;
    };

    readonly agentModelEffort = (): AgentModelEffort => ({
        effortSettingId: REASONING_EFFORT_SETTING_ID,
        modelSettingId: MODEL_SETTING_ID,
        resolution: AGENT_MODEL_EFFORT_RESOLUTION_COMPLETE,
        unsupportedModelIds: [],
        valuesByModel: Object.fromEntries(
            this.#models.map((model) => [
                model.id,
                effortValues(model).map((value) => ({ ...value, groupId: "", groupName: "" })),
            ]),
        ),
    });

    readonly selectRestoredThread = (thread: {
        readonly collaborationMode?: { readonly mode: "default" | "plan" } | null | undefined;
        readonly model?: string | null | undefined;
        readonly reasoningEffort?: string | null | undefined;
        readonly serviceTier?: string | null | undefined;
        readonly thread: { readonly id: string };
    }): void => {
        const supported = supportedSelection(
            this.#models,
            thread.model ?? this.#selection.model,
            thread.reasoningEffort ?? this.#selection.effort,
        );
        this.#selection = {
            ...this.#selection,
            ...supported,
            collaborationMode: thread.collaborationMode?.mode ?? this.#selection.collaborationMode,
            fastMode: thread.serviceTier === SERVICE_TIER_FAST,
        };
    };

    /**
     * Applies one `session/set_config_option`. Switching models re-resolves the effort the way Codex
     * does — the current effort when the new model supports it, otherwise the model's own default —
     * so the reply never advertises an effort the selected model cannot run.
     */
    readonly applySelection = (configId: string, value: string | boolean): void => {
        if (configId === FAST_MODE_SETTING_ID) {
            if (typeof value !== "boolean") {
                throw new AcpExecutionError(
                    "The requested Codex setting is invalid",
                    {},
                    "invalid_session_configuration",
                );
            }
            // A model without a speed tier has no fast mode, so enabling it there would advertise a
            // capability the next turn cannot honour.
            if (value && this.#model(this.#selection.model)?.additionalSpeedTiers?.includes(FAST_TIER) !== true) {
                throw new AcpExecutionError(
                    "The selected Codex model has no fast mode",
                    {},
                    "invalid_session_configuration",
                );
            }
            this.#selection = { ...this.#selection, fastMode: value };
            return;
        }
        if (typeof value !== "string") {
            throw new AcpExecutionError("The requested Codex setting is invalid", {}, "invalid_session_configuration");
        }
        if (configId === MODE_SETTING_ID) {
            if (!AGENT_MODES.some((mode) => mode.id === value)) {
                throw new AcpExecutionError(
                    "The requested Codex mode is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            this.#selection = { ...this.#selection, mode: value };
            return;
        }
        if (configId === COLLABORATION_MODE_SETTING_ID) {
            if (!COLLABORATION_MODES.some((mode) => mode.value === value)) {
                throw new AcpExecutionError(
                    "The requested Codex collaboration mode is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            this.#selection = { ...this.#selection, collaborationMode: value };
            this.#collaborationModeSelected = true;
            return;
        }
        if (configId === MODEL_SETTING_ID) {
            if (value === this.#selection.model) {
                return;
            }
            const model = this.#model(value);
            if (model === undefined) {
                throw new AcpExecutionError(
                    "The requested Codex model is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            const supported = (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort);
            const effort = supported.includes(this.#selection.effort)
                ? this.#selection.effort
                : (model.defaultReasoningEffort ?? supported[0] ?? "");
            // Fast mode follows the model: a model with no speed tier drops a fast mode that was on.
            this.#selection = {
                ...this.#selection,
                effort,
                fastMode: this.#selection.fastMode && model.additionalSpeedTiers?.includes(FAST_TIER) === true,
                model: value,
            };
            return;
        }
        if (configId === REASONING_EFFORT_SETTING_ID) {
            const supported = (this.#model(this.#selection.model)?.supportedReasoningEfforts ?? []).map(
                (option) => option.reasoningEffort,
            );
            if (!supported.includes(value)) {
                throw new AcpExecutionError(
                    "The requested Codex reasoning effort is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            this.#selection = { ...this.#selection, effort: value };
            return;
        }
        throw new AcpExecutionError("The requested Codex setting is unavailable", {}, "invalid_session_configuration");
    };
}
