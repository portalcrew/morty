import { MortyOperationError } from "@portalcrew/morty-client";
import type {
    SessionConfigOption,
    SessionConfigurationSelection,
    WorkspaceEntriesEvent,
} from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import {
    type BotChatApi,
    type BotComputerConfiguration,
    type ChatAgentSelection,
    type ChatDraftConfiguration,
    computerAgentAvailability,
    connectedChatComputerAgents,
} from "@/services/chat/bot-chat-api";
import { rememberAgentSettingChoice, restoreLastAgentSettings } from "@/services/chat/last-agent-settings";
import {
    forgetRecentCwdPreference,
    type RecentCwdPreference,
    readLastCwdPreference,
    readRecentCwdPreferences,
    saveLastCwdPreference,
    saveRecentCwdPreference,
} from "@/services/chat/last-cwd-preference";
import { centralLocalStorage, lastHarnessEntry } from "@/services/local-storage/central-local-storage";
import { isComputerConnectionFailure } from "@/services/management/management-api";
import type { AgentModelCatalog } from "../../services/diagnostics/model-catalog.ts";
import { formatError } from "../format-error.ts";
import { harnessOptions, nativeSessionAgentTabs } from "./native-session-agents.ts";
import { type DirectoryAvailability, type SessionDirectory, sessionDirectories } from "./recent-directories.ts";

/**
 * The open draft's Agent settings. Whether the Computer is online or offers an Agent is the Computer configuration's to
 * say, and the page shows it there, so a draft that cannot load for those reasons stays `loading`; only what the
 * configuration cannot know is kept.
 */
type DraftSettingsState =
    | { readonly kind: "loading" }
    /** A read failed because the Computer was unreachable although the configuration said it was online. */
    | { readonly kind: "unreachable" }
    | { readonly kind: "failed"; readonly message: string }
    | {
          readonly kind: "switching";
          readonly harness: string;
          /** The settings on screen until the new Agent's arrive; they cannot be submitted. */
          readonly shown: readonly SessionConfigOption[];
      }
    | {
          readonly kind: "refreshing";
          readonly selectedAgent: ChatAgentSelection;
          readonly cwd: WorkspaceEntriesEvent;
          /** The settings on screen until the refreshed ones arrive; they cannot be submitted. */
          readonly shown: readonly SessionConfigOption[];
      }
    | {
          readonly kind: "ready";
          readonly selectedAgent: ChatAgentSelection;
          readonly cwd: WorkspaceEntriesEvent;
          readonly options: readonly SessionConfigOption[];
          readonly catalog: AgentModelCatalog;
          /** Explicit or restored choices must be sent even when their values equal the Agent defaults. */
          readonly changedOptionIds: ReadonlySet<string>;
      };

type ReadyDraftSettings = Extract<DraftSettingsState, { readonly kind: "ready" }>;

export function draftShownOptions(settings: DraftSettingsState): readonly SessionConfigOption[] {
    switch (settings.kind) {
        case "ready":
            return settings.options;
        case "switching":
        case "refreshing":
            return settings.shown;
        case "loading":
        case "unreachable":
        case "failed":
            return [];
    }
}

export function draftHarnessSelection(settings: DraftSettingsState, configuration: BotComputerConfiguration | null) {
    const options = harnessOptions(configuration?.computer ?? null);
    const harness =
        settings.kind === "switching"
            ? settings.harness
            : settings.kind === "ready" || settings.kind === "refreshing"
              ? settings.selectedAgent.harness
              : null;
    return { options, value: options.find((option) => option.value === harness)?.value ?? "" };
}

export function draftConfiguration(settings: DraftSettingsState): ChatDraftConfiguration | null {
    if (settings.kind !== "ready") {
        return null;
    }
    return {
        harness: settings.selectedAgent.harness,
        workspaceRef: settings.cwd.directory,
        workspaceLabel: settings.cwd.directoryLabel,
        configurations: settings.options
            .filter((option) => option.category === "model" || settings.changedOptionIds.has(option.id))
            .map(
                (option): SessionConfigurationSelection =>
                    option.type === "boolean"
                        ? { booleanValue: option.booleanValue, configId: option.id, type: "boolean" }
                        : { configId: option.id, type: "select", value: option.currentValue },
            ),
    };
}

type CwdBrowserState =
    | { readonly kind: "closed" }
    | { readonly kind: "loading"; readonly directory: WorkspaceEntriesEvent; readonly path: string }
    | { readonly kind: "previewing"; readonly directory: WorkspaceEntriesEvent; readonly path: string }
    | { readonly kind: "ready"; readonly directory: WorkspaceEntriesEvent; readonly path: string }
    | {
          readonly kind: "failed";
          readonly directory: WorkspaceEntriesEvent;
          readonly message: string;
          readonly path: string;
      };

export interface DraftControlsStore {
    readonly cwdBrowser: CwdBrowserState;
    readonly directoryAvailability: ReadonlyMap<string, DirectoryAvailability>;
    readonly recentCwds: readonly RecentCwdPreference[];
    readonly settings: DraftSettingsState;
    readonly browseCwd: (directory: string, signal: AbortSignal) => Promise<void>;
    readonly closeCwd: () => void;
    readonly forgetRecentCwd: (directory: string) => void;
    readonly enter: (signal: AbortSignal) => Promise<void>;
    readonly leave: () => void;
    readonly retry: (signal: AbortSignal) => Promise<void>;
    readonly computerChanged: (configuration: BotComputerConfiguration, signal: AbortSignal) => Promise<void>;
    readonly openCwd: () => void;
    readonly refreshRecentCwds: () => void;
    readonly saveCwd: (signal: AbortSignal) => Promise<void>;
    readonly selectRecentCwd: (recent: RecentCwdPreference, signal: AbortSignal) => Promise<void>;
    readonly selectHarness: (value: string, disabled: boolean, signal: AbortSignal) => Promise<void>;
    readonly selectOption: (configId: string, value: string) => void;
    readonly toggleOption: (configId: string) => void;
    readonly setCwdPath: (path: string, signal: AbortSignal) => void;
    readonly verifySessionDirectories: (sessions: readonly SessionDirectory[], signal: AbortSignal) => Promise<void>;
}

const CWD_PREVIEW_DEBOUNCE_MILLISECONDS = 1_000;

function failureMessage(cause: unknown): string {
    return formatError(cause, "The working directory is unavailable.");
}

function waitForCwdPreview(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const timeout = window.setTimeout(finish, CWD_PREVIEW_DEBOUNCE_MILLISECONDS);
        function finish(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", cancel);
            resolve();
        }
        function cancel(): void {
            window.clearTimeout(timeout);
            signal.removeEventListener("abort", cancel);
            reject(signal.reason);
        }
        signal.addEventListener("abort", cancel, { once: true });
    });
}

export const createDraftControlsStore = (
    computerId: string,
    requests: Pick<BotChatApi, "directory" | "agentSettings">,
    computerConfiguration: () => BotComputerConfiguration | null,
    onUnreachable: () => void,
) =>
    createStore<DraftControlsStore>()((set, get) => {
        let cwdOperation: AbortController | null = null;
        let directoryVerification: AbortController | null = null;
        // Agent settings belong to the Computer configuration they were read under: a different configuration, as
        // after the Computer reconnects or its Agents change, drops them. They also belong to the directory a Session
        // would start in, whose project settings the Agent reads.
        let agentSettings: {
            readonly computer: string | null;
            readonly entries: Map<string, Awaited<ReturnType<BotChatApi["agentSettings"]>>>;
        } = { computer: null, entries: new Map() };
        // The selected draft's lifetime. Every settings operation runs within it, and none runs without one.
        let draft: { readonly controller: AbortController; readonly signal: AbortSignal } | null = null;
        // Every operation that writes the draft's settings (a load, a refresh, a harness switch, a directory choice)
        // takes this one lane: starting one stops the previous, and only the newest may write. A Computer
        // configuration change starts its own, so nothing read under an older configuration is shown or cached.
        let settingsOperation: AbortController | null = null;
        const beginSettingsOperation = (parent: AbortSignal) => {
            if (draft === null) {
                return null;
            }
            settingsOperation?.abort(new Error("A newer draft settings operation started."));
            const controller = new AbortController();
            settingsOperation = controller;
            const lifetime = draft.signal;
            return {
                signal: AbortSignal.any([parent, lifetime, controller.signal, AbortSignal.timeout(120_000)]),
                current: (): boolean => settingsOperation === controller && !parent.aborted && !lifetime.aborted,
                finish: (): void => {
                    if (settingsOperation === controller) {
                        settingsOperation = null;
                    }
                },
            };
        };
        type SettingsOperation = NonNullable<ReturnType<typeof beginSettingsOperation>>;
        const readAgentSettings = async (
            harness: string,
            cwd: WorkspaceEntriesEvent,
            refresh: boolean,
            operation: SettingsOperation,
        ) => {
            const cache = agentSettings;
            const key = JSON.stringify([harness, cwd.directory]);
            const cached = refresh ? undefined : cache.entries.get(key);
            if (cached !== undefined) {
                return cached;
            }
            const result = await requests.agentSettings(harness, cwd.directory, operation.signal);
            if (operation.current() && agentSettings === cache) {
                cache.entries.set(key, result);
            }
            return result;
        };
        /**
         * A directory choice writes the draft's settings and belongs to the directory browser, so it takes both
         * lanes: a newer settings operation supersedes it, and closing, editing or browsing directories cancels it.
         * It may write only while it is current in both.
         */
        const beginDirectoryChoice = (parent: AbortSignal) => {
            const settings = beginSettingsOperation(parent);
            if (settings === null) {
                return null;
            }
            cwdOperation?.abort();
            const browsing = new AbortController();
            cwdOperation = browsing;
            return {
                signal: AbortSignal.any([settings.signal, browsing.signal]),
                current: (): boolean => settings.current() && cwdOperation === browsing,
                release: (): void => {
                    settings.finish();
                    if (cwdOperation === browsing) {
                        cwdOperation = null;
                    }
                },
            };
        };
        /**
         * A read that found the Computer unreachable says so and offers Retry; the workspace retries it once the Computer
         * is reachable again.
         */
        const settleFailure = (cause: unknown, message: string): void => {
            if (isComputerConnectionFailure(cause)) {
                set({ settings: { kind: "unreachable" } });
                onUnreachable();
                return;
            }
            set({ settings: { kind: "failed", message: formatError(cause, message) } });
        };
        const rememberDirectory = (
            settings: ReadyDraftSettings,
            directory: WorkspaceEntriesEvent,
        ): readonly RecentCwdPreference[] => {
            const selected = settings.selectedAgent;
            saveLastCwdPreference(computerId, selected.harness, directory.directory);
            return saveRecentCwdPreference(computerId, {
                directory: directory.directory,
                directoryLabel: directory.directoryLabel,
            });
        };
        const applyDirectory = async (
            settings: ReadyDraftSettings,
            directory: WorkspaceEntriesEvent,
            signal: AbortSignal,
        ): Promise<void> => {
            const recentCwds = rememberDirectory(settings, directory);
            set({ cwdBrowser: { kind: "closed" }, recentCwds });
            await refreshSettings({ ...settings, cwd: directory }, false, signal);
        };
        const applyAgentSettings = (
            selectedAgent: ChatAgentSelection,
            cwd: WorkspaceEntriesEvent,
            result: Awaited<ReturnType<BotChatApi["agentSettings"]>>,
            rememberHarness: boolean,
        ): void => {
            const restoredSettings = restoreLastAgentSettings(computerId, selectedAgent.harness, result.options);
            const ready = {
                kind: "ready" as const,
                selectedAgent,
                cwd,
                options: restoredSettings.options,
                catalog: result.catalog,
                changedOptionIds: restoredSettings.restoredIds,
            };
            // A harness becomes the remembered default only once its settings
            // are actually applied. A fallback to another connected Agent, or
            // a load that fails, must leave the user's choice in place.
            if (rememberHarness) {
                centralLocalStorage.write(lastHarnessEntry(computerId), selectedAgent.harness);
            }
            // The directory is remembered only where the user chooses one (`rememberDirectory`, a handoff), never
            // from the directory a draft happened to load in.
            const existingRecentCwds = readRecentCwdPreferences(computerId);
            const recentCwds =
                existingRecentCwds === null
                    ? saveRecentCwdPreference(computerId, {
                          directory: cwd.directory,
                          directoryLabel: cwd.directoryLabel,
                      })
                    : existingRecentCwds;
            set({ settings: ready, recentCwds });
        };
        const browseCwd = async (directory: string, lifetimeSignal: AbortSignal): Promise<void> => {
            const settings = get().settings;
            if (settings.kind !== "ready") {
                return;
            }
            const currentBrowser = get().cwdBrowser;
            const previousPath = currentBrowser.kind === "closed" ? settings.cwd.directoryLabel : currentBrowser.path;
            const previousDirectory = currentBrowser.kind === "closed" ? settings.cwd : currentBrowser.directory;
            cwdOperation?.abort();
            const operation = new AbortController();
            cwdOperation = operation;
            const signal = AbortSignal.any([lifetimeSignal, operation.signal, AbortSignal.timeout(120_000)]);
            set({ cwdBrowser: { kind: "loading", directory: previousDirectory, path: previousPath } });
            try {
                const listing = await requests.directory(directory, signal);
                signal.throwIfAborted();
                set({ cwdBrowser: { kind: "ready", directory: listing, path: listing.directoryLabel } });
            } catch (cause) {
                if (operation.signal.aborted) {
                    return;
                }
                lifetimeSignal.throwIfAborted();
                set({
                    cwdBrowser: {
                        kind: "failed",
                        directory: previousDirectory,
                        message: failureMessage(cause),
                        path: previousPath,
                    },
                });
            } finally {
                if (cwdOperation === operation) {
                    cwdOperation = null;
                }
            }
        };
        const previewCwd = async (path: string, lifetimeSignal: AbortSignal): Promise<void> => {
            const browser = get().cwdBrowser;
            if (browser.kind === "closed") {
                return;
            }
            cwdOperation?.abort();
            const operation = new AbortController();
            cwdOperation = operation;
            const signal = AbortSignal.any([lifetimeSignal, operation.signal, AbortSignal.timeout(120_000)]);
            try {
                await waitForCwdPreview(signal);
                const requestedPath = path.trim();
                if (requestedPath.length === 0) {
                    set({
                        cwdBrowser: {
                            kind: "failed",
                            directory: browser.directory,
                            message: "Enter a working directory path.",
                            path,
                        },
                    });
                    return;
                }
                const directory = await requests.directory(requestedPath, signal);
                signal.throwIfAborted();
                set({ cwdBrowser: { kind: "ready", directory, path: directory.directoryLabel } });
            } catch (cause) {
                if (operation.signal.aborted) {
                    return;
                }
                lifetimeSignal.throwIfAborted();
                set({
                    cwdBrowser: {
                        kind: "failed",
                        directory: browser.directory,
                        message: failureMessage(cause),
                        path,
                    },
                });
            } finally {
                if (cwdOperation === operation) {
                    cwdOperation = null;
                }
            }
        };
        const load = async (parent: AbortSignal): Promise<void> => {
            const operation = beginSettingsOperation(parent);
            if (operation === null) {
                return;
            }
            const currentSettings = get().settings;
            // Nothing from the previous harness may stay submittable while the
            // target harness and its settings load: a message sent in that
            // window would create a conversation on the harness being left.
            if (currentSettings.kind !== "switching") {
                set({ settings: { kind: "loading" } });
            }
            try {
                const switching = currentSettings.kind === "switching";
                const requestedHarness = switching
                    ? currentSettings.harness
                    : centralLocalStorage.read(lastHarnessEntry(computerId));
                const configuration = computerConfiguration();
                const agents =
                    configuration === null || computerAgentAvailability(configuration.computer) !== "available"
                        ? []
                        : connectedChatComputerAgents(configuration.computer);
                // A requested harness the Computer does not offer must not block the draft; the first connected Agent
                // stands in until the user chooses again.
                const requestedAgent = agents.find((agent) => agent.harness === requestedHarness);
                const selected = requestedAgent ?? agents[0];
                if (selected === undefined) {
                    // The configuration says why nothing can load yet; the next configuration the page observes loads
                    // the draft. A switch that cannot land is dropped rather than remembered.
                    set({ settings: { kind: "loading" } });
                    return;
                }
                const defaultCwd = await requests.directory(".", operation.signal);
                operation.signal.throwIfAborted();
                const savedDirectory = readLastCwdPreference(computerId, selected.harness);
                let cwd = defaultCwd;
                if (savedDirectory !== null && savedDirectory !== defaultCwd.directory) {
                    try {
                        cwd = await requests.directory(savedDirectory, operation.signal);
                        operation.signal.throwIfAborted();
                    } catch {
                        // An unreadable chosen directory gives way to the default for this draft only; the choice
                        // stays remembered for when the Computer can read it again.
                        operation.signal.throwIfAborted();
                    }
                }
                // The settings are read in the directory the Session would start in. A deliberate Agent switch must
                // be acknowledged by the live Computer, not satisfied by settings cached before the user made the choice.
                const result = await readAgentSettings(selected.harness, cwd, switching, operation);
                operation.signal.throwIfAborted();
                if (!operation.current()) {
                    return;
                }
                // The Computer can drop while these reads are in flight. A switch
                // that never lands must not become the remembered harness.
                const live = computerConfiguration();
                if (live === null || !live.computer.online) {
                    set({ settings: { kind: "loading" } });
                    return;
                }
                // Applying the settings and remembering the choice settle together, without an asynchronous gap.
                // A failed, cancelled, superseded or offline switch never changes the remembered preference.
                applyAgentSettings(selected, cwd, result, requestedAgent !== undefined);
            } catch (cause) {
                if (operation.current()) {
                    settleFailure(cause, "Harness settings are unavailable.");
                }
            } finally {
                operation.finish();
            }
        };
        const refreshSettings = async (
            settings: Extract<DraftSettingsState, { readonly kind: "ready" | "refreshing" }>,
            refresh: boolean,
            parent: AbortSignal,
        ): Promise<void> => {
            const operation = beginSettingsOperation(parent);
            if (operation === null) {
                return;
            }
            set({
                settings: {
                    kind: "refreshing",
                    selectedAgent: settings.selectedAgent,
                    cwd: settings.cwd,
                    shown: draftShownOptions(settings),
                },
            });
            try {
                const result = await readAgentSettings(
                    settings.selectedAgent.harness,
                    settings.cwd,
                    refresh,
                    operation,
                );
                operation.signal.throwIfAborted();
                if (operation.current()) {
                    applyAgentSettings(settings.selectedAgent, settings.cwd, result, false);
                }
            } catch (cause) {
                if (operation.current()) {
                    settleFailure(cause, "Harness settings are unavailable.");
                }
            } finally {
                operation.finish();
            }
        };
        return {
            cwdBrowser: { kind: "closed" },
            directoryAvailability: new Map(),
            recentCwds: readRecentCwdPreferences(computerId) ?? [],
            settings: { kind: "loading" },
            browseCwd,
            closeCwd: () => {
                cwdOperation?.abort();
                cwdOperation = null;
                set({ cwdBrowser: { kind: "closed" } });
            },
            forgetRecentCwd: (directory) => {
                const settings = get().settings;
                const selected = settings.kind === "ready" ? settings.selectedAgent : null;
                const recentCwds = get().recentCwds;
                if (selected === null || !recentCwds.some((recent) => recent.directory === directory)) {
                    return;
                }
                set({ recentCwds: forgetRecentCwdPreference(computerId, directory) });
            },
            enter: async (signal) => {
                draft?.controller.abort(new Error("Another draft was selected."));
                const controller = new AbortController();
                draft = { controller, signal: AbortSignal.any([signal, controller.signal]) };
                await load(signal);
            },
            leave: () => {
                if (draft === null) {
                    return;
                }
                draft.controller.abort(new Error("The draft was left."));
                draft = null;
                settingsOperation?.abort(new Error("The draft was left."));
                settingsOperation = null;
                cwdOperation?.abort();
                cwdOperation = null;
                set({ settings: { kind: "loading" }, cwdBrowser: { kind: "closed" } });
            },
            retry: async (signal) => {
                await load(signal);
            },
            computerChanged: async (configuration, signal) => {
                const computer = JSON.stringify(configuration.computer);
                const changed = computer !== agentSettings.computer;
                if (changed) {
                    agentSettings = { computer, entries: new Map() };
                }
                if (draft === null) {
                    return;
                }
                const settings = get().settings;
                // An offline Computer offers nothing for now, which says nothing about whether the Agent was removed.
                // A harness switch still in flight has to stop here, or its late response would be remembered.
                if (!configuration.computer.online) {
                    if (settings.kind === "switching") {
                        settingsOperation?.abort(new Error("The Computer went offline."));
                        settingsOperation = null;
                        set({ settings: { kind: "loading" } });
                    }
                    return;
                }
                const waiting =
                    settings.kind === "unreachable" || (settings.kind === "loading" && settingsOperation === null);
                if (!changed && !waiting) {
                    return;
                }
                const selectedAgent =
                    settings.kind === "ready" || settings.kind === "refreshing" ? settings.selectedAgent : null;
                const offered =
                    selectedAgent !== null &&
                    connectedChatComputerAgents(configuration.computer).some(
                        (agent) => agent.harness === selectedAgent.harness,
                    );
                if (offered && (settings.kind === "ready" || settings.kind === "refreshing")) {
                    await refreshSettings(settings, false, signal);
                    return;
                }
                await load(signal);
            },
            openCwd: () => {
                const settings = get().settings;
                if (settings.kind === "ready") {
                    set({ cwdBrowser: { kind: "ready", directory: settings.cwd, path: settings.cwd.directoryLabel } });
                }
            },
            refreshRecentCwds: () => {
                set({ recentCwds: readRecentCwdPreferences(computerId) ?? [] });
            },
            saveCwd: async (signal) => {
                const browser = get().cwdBrowser;
                const settings = get().settings;
                if (
                    browser.kind === "closed" ||
                    browser.kind === "loading" ||
                    browser.kind === "previewing" ||
                    settings.kind !== "ready"
                ) {
                    return;
                }
                const requestedPath = browser.path.trim();
                if (requestedPath.length === 0) {
                    cwdOperation?.abort();
                    cwdOperation = null;
                    set({
                        cwdBrowser: {
                            kind: "failed",
                            directory: browser.directory,
                            message: "Enter a working directory path.",
                            path: browser.path,
                        },
                    });
                    return;
                }
                const operation = beginDirectoryChoice(signal);
                if (operation === null) {
                    return;
                }
                let directory = browser.directory;
                if (requestedPath !== browser.directory.directoryLabel) {
                    const loading = { kind: "loading", directory: browser.directory, path: browser.path } as const;
                    set({ cwdBrowser: loading });
                    try {
                        directory = await requests.directory(requestedPath, operation.signal);
                        operation.signal.throwIfAborted();
                    } catch (cause) {
                        if (signal.aborted) {
                            return;
                        }
                        if (!operation.current()) {
                            // Cancelled or superseded: undo only this choice's own loading state.
                            if (get().cwdBrowser === loading) {
                                set({ cwdBrowser: browser });
                            }
                            return;
                        }
                        operation.release();
                        set({
                            cwdBrowser: {
                                kind: "failed",
                                directory: browser.directory,
                                message: failureMessage(cause),
                                path: browser.path,
                            },
                        });
                        return;
                    }
                }
                if (operation.current()) {
                    operation.release();
                    await applyDirectory(settings, directory, signal);
                }
            },
            selectRecentCwd: async (recent, signal) => {
                const settings = get().settings;
                if (settings.kind !== "ready") {
                    return;
                }
                const operation = beginDirectoryChoice(signal);
                if (operation === null) {
                    return;
                }
                try {
                    const listing = await requests.directory(recent.directory, operation.signal);
                    operation.signal.throwIfAborted();
                    if (operation.current()) {
                        operation.release();
                        await applyDirectory(settings, listing, signal);
                    }
                } catch (cause) {
                    if (signal.aborted || !operation.current()) {
                        return;
                    }
                    operation.release();
                    set({
                        cwdBrowser: {
                            kind: "failed",
                            directory: settings.cwd,
                            message: failureMessage(cause),
                            path: recent.directoryLabel,
                        },
                    });
                }
            },
            selectHarness: async (value, disabled, signal) => {
                const settings = get().settings;
                if (settings.kind !== "ready" || disabled) {
                    return;
                }
                // The Computer's Agents can change while the draft is open; choose among those it offers now.
                const configuration = computerConfiguration();
                const agent = (configuration === null ? [] : nativeSessionAgentTabs(configuration.computer)).find(
                    (item) => item.installed && item.harness === value,
                );
                if (agent === undefined) {
                    return;
                }
                set({ settings: { kind: "switching", harness: agent.harness, shown: settings.options } });
                await load(signal);
            },
            selectOption: (configId, value) => {
                const settings = get().settings;
                if (settings.kind !== "ready") {
                    return;
                }
                const ready = {
                    ...settings,
                    changedOptionIds: new Set([...settings.changedOptionIds, configId]),
                    options: settings.options.map((option) =>
                        option.id === configId && option.type === "select"
                            ? { ...option, currentValue: value }
                            : option,
                    ),
                };
                if (settings.options.some((option) => option.id === configId && option.type === "select")) {
                    rememberAgentSettingChoice(computerId, settings.selectedAgent.harness, {
                        configId,
                        type: "select",
                        value,
                    });
                }
                set({ settings: ready });
            },
            toggleOption: (configId) => {
                const settings = get().settings;
                if (settings.kind !== "ready") {
                    return;
                }
                const ready = {
                    ...settings,
                    changedOptionIds: new Set([...settings.changedOptionIds, configId]),
                    options: settings.options.map((option) =>
                        option.id === configId && option.type === "boolean"
                            ? { ...option, booleanValue: !option.booleanValue }
                            : option,
                    ),
                };
                const toggled = ready.options.find((option) => option.id === configId);
                if (toggled?.type === "boolean") {
                    rememberAgentSettingChoice(computerId, settings.selectedAgent.harness, {
                        booleanValue: toggled.booleanValue,
                        configId,
                        type: "boolean",
                    });
                }
                set({ settings: ready });
            },
            setCwdPath: (path, signal) => {
                const browser = get().cwdBrowser;
                if (browser.kind !== "closed") {
                    cwdOperation?.abort();
                    cwdOperation = null;
                    set({ cwdBrowser: { kind: "previewing", directory: browser.directory, path } });
                    void previewCwd(path, signal);
                }
            },
            verifySessionDirectories: async (sessions, parent) => {
                directoryVerification?.abort(new Error("A newer Session listing arrived."));
                const verification = new AbortController();
                directoryVerification = verification;
                const signal = AbortSignal.any([parent, verification.signal]);
                try {
                    for (const { directory } of sessionDirectories(sessions)) {
                        if (get().directoryAvailability.has(directory)) {
                            continue;
                        }
                        let availability: DirectoryAvailability;
                        try {
                            await requests.directory(directory, signal);
                            availability = "available";
                        } catch (cause) {
                            signal.throwIfAborted();
                            // Only the Computer's refusal shows a directory is gone; any other failure leaves every
                            // directory unconfirmed until the next listing.
                            if (
                                !(cause instanceof MortyOperationError && cause.code === "local_authorization_failed")
                            ) {
                                return;
                            }
                            availability = "missing";
                        }
                        signal.throwIfAborted();
                        set({
                            directoryAvailability: new Map(get().directoryAvailability).set(directory, availability),
                        });
                    }
                } finally {
                    if (directoryVerification === verification) {
                        directoryVerification = null;
                    }
                }
            },
        };
    });
