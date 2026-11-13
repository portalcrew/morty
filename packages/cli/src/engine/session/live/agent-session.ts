import { conversationTitleFromText } from "@morty-build/client";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    type AgentModelEffort,
    isIdentifier,
    type NativeSessionTarget,
    type SessionCapabilities,
    type SessionCommand,
    type SessionConfigOption,
    type SessionConfigurationSelection,
    type SessionEventPayload,
    type SessionInteractionSnapshot,
} from "@morty-build/client/protocol";
import { AcpExecutionError, AcpPromptExecutionError } from "../../acp/acp-error.ts";
import { RetryableAcpInitializationError, validateAgentRuntime } from "../../acp/adapter/agent-initialization.ts";
import type { NativeSessionEvent, NativeSessionSubscriber } from "../../acp/adapter/native-session-event.ts";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { BackgroundActivity } from "../../acp/agent/agent-lifecycle.ts";
import { validatePromptContent } from "../../acp/client/prompt-content.ts";
import type {
    Adapter,
    AdapterSessionCreateParams,
    AdapterSessionOpened,
    AdapterSessionScope,
    AdapterSessionTarget,
    NativeHistoryRevision,
} from "../../acp/native-history/preview-contract.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";
import { unsupportedSessionCapabilities } from "../../acp/protocol/session-capabilities.ts";
import type { OperationMetrics } from "../../infra/operation-metrics.ts";
import { SerialTaskQueue } from "../../util/serial-task-queue.ts";
import { recordsEqual, truncate } from "../../util/value-utils.ts";
import {
    type ElicitationResponseOptions,
    type PermissionResponseOptions,
    PreparedSession,
    type PromptResult,
    type SessionConfigurationChange,
    type SessionConfigurationSnapshot,
    type SessionConfigureOptions,
    type SessionCreationOptions,
    type SessionObserver,
    type SessionPrepareOptions,
    type SessionRecovery,
    type SessionSteerOptions,
    type SessionTurnOptions,
} from "../api/session-api.ts";
import type { SessionEventPage } from "../history/session-event-store.ts";
import { HistoryReplayCapture } from "../history/session-history.ts";
import { SessionInteractions } from "../interaction/session-interactions.ts";
import { waitForSharedOperation } from "../manager/operation-drain.ts";
import { type SessionStore, StoredSession } from "../record/session-store.ts";
import type { SettledTurn } from "../turn/execution-receipts.ts";
import { configurationRevision } from "./configuration-revision.ts";
import { SessionConfigurations } from "./session-configurations.ts";
import { restoredConversation, restoreOpening } from "./session-restore.ts";

/** Attributes Agent requests that arrive while the Agent holds no prompt of this Session. */
const SESSION_CONTROL_COMMAND_ID = "session-control";

/** What the Session's execution authority tells its Agent session. */
export interface SessionExecutionRecord {
    /** The command whose prompt the Session's Agent holds. */
    readonly agentCommand: (target: NativeSessionTarget) => string | undefined;
    /** The Session's settled turns, which a replayed history places among the Agent's own events. */
    readonly settledTurns: (target: NativeSessionTarget) => readonly SettledTurn[];
}

/** The Session's history in this process: not loaded, being replayed by the Agent, or held. */
type SessionLoadState =
    | { readonly kind: "not-requested" }
    | {
          readonly kind: "capturing";
          readonly history: HistoryReplayCapture;
          readonly completion: Promise<AdapterSessionOpened>;
      }
    | { readonly kind: "loaded"; readonly history: HistoryReplayCapture };

/** How this process came to hold its native conversation. */
type SessionOrigin = "created" | "reopened" | "forked";

/**
 * The native conversation this process holds. A created or forked conversation awaits the identity the harness gives
 * it; a reopened one is expected under its known target until restore binds it. A bound conversation is prompted once
 * a prompt has been handed to its Agent; a created one has no history of its own until then.
 */
type NativeIdentity =
    | { readonly kind: "awaiting"; readonly origin: Exclude<SessionOrigin, "reopened"> }
    | { readonly kind: "expected"; readonly target: NativeSessionTarget }
    | {
          readonly kind: "bound";
          readonly target: NativeSessionTarget;
          readonly origin: SessionOrigin;
          readonly prompted: boolean;
      };

type UnboundIdentity = Exclude<NativeIdentity, { readonly kind: "bound" }>;

/** The native conversation entry this process continues from, recorded after its own writes settle. */
type NativeHistoryBaseline =
    | { readonly kind: "unavailable" }
    | { readonly kind: "recording"; readonly completion: Promise<void> }
    | { readonly kind: "recorded"; readonly latestEntryId: string };

export class AgentSession {
    get target(): NativeSessionTarget {
        if (this.#identity.kind === "awaiting") {
            throw new AcpExecutionError("The harness has not established a Session", {}, "invalid_agent_session");
        }
        return this.#identity.target;
    }

    readonly hasBackgroundActivity = (): boolean => this.#backgroundActivity !== "none";
    #backgroundActivity: BackgroundActivity = "none";
    /** The command whose prompt the Agent is running, which only the Agent can report as delegated. */
    #delegableCommandId: string | null = null;
    #modelEffort: AgentModelEffort | null = null;
    readonly #scope: AdapterSessionScope;
    readonly #subscriber: NativeSessionSubscriber;
    #identity: NativeIdentity;
    /**
     * Whether the Runtime holds this Session: its record exists, so it is listed and its target can be used. A Session
     * being created is not held until its creation completes, so one that fails midway leaves no record behind.
     */
    #holding: "held" | "unheld" = "held";
    readonly #adapter: Adapter;
    readonly #harness: string;
    readonly #cwd: string;
    readonly #environment: Readonly<Record<string, string>>;
    readonly #observer: SessionObserver;
    readonly #agentCommand: () => string | undefined;
    readonly #settledTurns: () => readonly SettledTurn[];
    readonly #interactions: SessionInteractions;
    readonly #metrics: OperationMetrics;
    readonly #store: SessionStore;
    #agentName = "";
    #agentVersion = "";
    #capabilities: SessionCapabilities = unsupportedSessionCapabilities();
    #commands: readonly SessionCommand[] = [];
    readonly #configurationChanges = new SerialTaskQueue();
    #configOptions: readonly SessionConfigOption[] = [];
    readonly #sessionConfigurations = new SessionConfigurations();
    #nativeHistoryBaseline: NativeHistoryBaseline = { kind: "unavailable" };
    #nativeHistoryWrites = 0;
    #sessionLoad: SessionLoadState = { kind: "not-requested" };
    /** The Session's title; empty until the Agent reports one or the first prompt names it. */
    #sessionTitle = "";
    /** The modification time the Agent reported; null until it reports one. */
    #sessionUpdatedAt: string | null = null;

    private constructor(
        agent: AcpAgentDefinition,
        cwd: string,
        identity: UnboundIdentity,
        observer: SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        metrics: OperationMetrics,
        adapter: Adapter,
        externalize: SessionPrepareOptions["externalizeSessionUpdate"],
    ) {
        this.#agentCommand = () => execution.agentCommand(this.target);
        this.#settledTurns = () => execution.settledTurns(this.target);
        this.#adapter = adapter;
        this.#harness = agent.harness;
        this.#commands = [];
        this.#cwd = cwd;
        this.#environment = agent.environment;
        this.#identity = identity;
        this.#metrics = metrics;
        this.#store = store;
        this.#observer = observer;
        this.#interactions = new SessionInteractions({
            cwd: () => this.#cwd,
            getToolCall: (toolCallId) => this.#store.events.getToolCall(this.target, toolCallId),
            target: () => this.target,
            commandId: () => this.#agentCommand() ?? SESSION_CONTROL_COMMAND_ID,
            assertNativeSession: this.assertNativeSession,
            recordSessionEvent: this.recordLifecycleEvent,
        });
        this.#scope = {
            agent,
            cwd,
            ...(externalize === undefined
                ? {}
                : {
                      externalizeUpdate: (sessionId, update, signal) => {
                          this.#adoptNativeSession(sessionId);
                          return externalize(this.target, update, signal);
                      },
                  }),
        };
        this.#subscriber = {
            onSessionEvent: async (sessionId, event) => {
                this.#adoptNativeSession(sessionId);
                await this.#processEvent(event);
            },
            onBackgroundActivity: (activity) => {
                const previous = this.#backgroundActivity;
                this.#backgroundActivity = activity;
                this.#observer.onBackgroundActivity?.(this, activity);
                if (previous !== "none" && activity === "none") {
                    // Background work may have appended to native history on this process's behalf.
                    void this.#recordNativeHistoryRevision();
                }
            },
            onPromptDelegation: async (stage) => {
                // Only the prompt this Session is running can be delegated; a late report has no command to name.
                const commandId = this.#delegableCommandId;
                if (commandId !== null) {
                    await this.recordLifecycleEvent({
                        payload: { commandId, kind: "prompt.delegated", stage },
                        type: "lifecycle-metadata",
                    });
                }
            },
            interactions: {
                onPermission: this.#interactions.onPermission,
                onElicitation: this.#interactions.onElicitation,
                onElicitationComplete: this.#interactions.onElicitationComplete,
            },
        };
    }

    static async #start(
        options: SessionCreationOptions,
        identity: UnboundIdentity,
        observer: SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        initialize: (runtime: AgentSession) => Promise<void>,
        metrics: OperationMetrics,
        adapter: Adapter,
    ): Promise<AgentSession> {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await metrics.measure(
                "executable-validation",
                async () => await validateAgentRuntime(options.agent, options.signal),
            );
            const runtime = metrics.measureSync(
                "process-spawn",
                () =>
                    new AgentSession(
                        options.agent,
                        options.cwd,
                        identity,
                        observer,
                        execution,
                        store,
                        metrics,
                        adapter,
                        options.externalizeSessionUpdate,
                    ),
            );
            try {
                await initialize(runtime);
                return runtime;
            } catch (error) {
                try {
                    await runtime.closeProcess();
                } finally {
                    // A conversation the harness created for this attempt is not kept.
                    if (runtime.#identity.kind === "bound" && runtime.#identity.origin !== "reopened") {
                        store.remove(runtime.target);
                    }
                }
                options.signal.throwIfAborted();
                if (error instanceof RetryableAcpInitializationError && attempt === 1) {
                    console.warn(`[${options.agent.harness}-acp] ACP agent initialization failed; retrying once`);
                    continue;
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent initialization failed", {
                    cause: error,
                });
            }
        }
        throw new AcpExecutionError("ACP agent initialization failed");
    }

    static readonly start = async (
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        observer: SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        metrics: OperationMetrics,
        adapter: Adapter,
        capabilities: SessionCapabilities = unsupportedSessionCapabilities(),
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            { kind: "expected", target: options.target },
            observer,
            execution,
            store,
            async (runtime) => {
                runtime.#capabilities = capabilities;
                await runtime.#writeNativeHistory(
                    async () => await runtime.#restore(options.signal, recovery, options.origin),
                );
            },
            metrics,
            adapter,
        );

    static readonly create = async (
        options: SessionCreationOptions,
        observer: SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        metrics: OperationMetrics,
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            { kind: "awaiting", origin: "created" },
            observer,
            execution,
            store,
            async (runtime) => {
                runtime.#holding = "unheld";
                const opened = await runtime.#writeNativeHistory(
                    async () => await runtime.#adapter.createSession(runtime.#sessionParams(options.signal)),
                );
                runtime.#adoptNativeSession(opened.sessionId);
                runtime.#applySessionOpened(opened);
                options.signal.throwIfAborted();
            },
            metrics,
            options.adapter,
        );

    static readonly fork = async (
        options: SessionCreationOptions,
        origin: Extract<NativeSessionOrigin, { readonly kind: "fork" }>,
        capabilities: SessionCapabilities,
        observer: SessionObserver,
        execution: SessionExecutionRecord,
        store: SessionStore,
        metrics: OperationMetrics,
    ): Promise<AgentSession> =>
        await AgentSession.#start(
            options,
            { kind: "awaiting", origin: "forked" },
            observer,
            execution,
            store,
            async (runtime) => {
                runtime.#capabilities = capabilities;
                const source = store.read({ harness: options.agent.harness, sessionId: origin.sessionId });
                const opened = await runtime.#writeNativeHistory(
                    async () =>
                        await runtime.#adapter.forkSession({
                            ...runtime.#sessionParams(options.signal),
                            sourceSessionId: origin.sessionId,
                        }),
                );
                if (opened.sessionId === origin.sessionId) {
                    throw new AcpExecutionError(
                        "The harness did not create an independent fork",
                        {},
                        "invalid_native_session_response",
                    );
                }
                runtime.#adoptNativeSession(opened.sessionId);
                runtime.#applySessionOpened(opened);
                runtime.#sessionTitle = origin.title;
                if (source !== undefined) {
                    await runtime.#restoreStoredConfigurations(source, options.signal, "fork");
                }
                options.signal.throwIfAborted();
                runtime.writeStoredSession(new Date().toISOString());
            },
            metrics,
            options.adapter,
        );

    /** A live process keeps the directory it started in; its Agent is the one its target names. */
    readonly runsIn = (cwd: string): boolean => this.#cwd === cwd;

    readonly usesEnvironment = (environment: Readonly<Record<string, string>>): boolean =>
        recordsEqual(this.#environment, environment);

    /** The Runtime now holds this Session: its record is written, and every later change updates it. */
    readonly hold = (): void => {
        this.#holding = "held";
        this.writeStoredSession(new Date().toISOString());
    };

    readonly writeStoredSession = (updatedAt: string): void => {
        if (this.#holding === "unheld") {
            return;
        }
        this.#store.write(
            new StoredSession(
                this.target,
                this.#cwd,
                this.#prompted(),
                this.#sessionTitle,
                // Agent metadata owns modification time; local activity is only a fallback until it reports one.
                this.#sessionUpdatedAt ?? updatedAt,
                this.#sessionConfigurations.stored(),
            ),
        );
    };

    /**
     * Applies a client-requested title change. Agents that advertise the
     * `_session/rename` extension receive the new title first so their own
     * session state follows; the daemon then records the rename in the Session
     * event log as an ACP `session_info_update` so every projection and recorded
     * directory observes the same title transition.
     */
    readonly renameSession = async (
        title: string,
        signal: AbortSignal,
    ): Promise<{ readonly title: string; readonly updatedAt: string }> => {
        const normalized = truncate(title, 500);
        if (normalized.length === 0) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
        if (this.#identity.kind === "bound") {
            await this.#writeNativeHistory(
                async () => await this.#adapter.renameSession({ ...this.#target(), title: normalized, signal }),
            );
        }
        const updatedAt = new Date().toISOString();
        await this.#processEvent({
            kind: "info",
            changes: [
                { kind: "title", value: normalized },
                { kind: "updated-at", value: updatedAt },
            ],
            payload: { sessionUpdate: "session_info_update", title: normalized, updatedAt },
        });
        return { title: this.#sessionTitle.length > 0 ? this.#sessionTitle : normalized, updatedAt };
    };

    readonly #captureSelectedConfigurationValues = (): void => {
        this.#sessionConfigurations.capture(this.#configOptions);
        if (this.#identity.kind === "bound") {
            this.writeStoredSession(new Date().toISOString());
        }
    };

    readonly #restoreStoredConfigurations = async (
        session: StoredSession,
        signal: AbortSignal,
        intent: "restore" | "fork" = "restore",
    ): Promise<void> => {
        await this.#sessionConfigurations.restore(
            session.configurations,
            () => this.#configOptions,
            this.#applyConfiguration,
            signal,
        );
        if (intent === "fork") {
            for (const selection of session.configurations) {
                // Mode carries the Agent's execution/approval constraint. Keep the existing
                // best-effort behavior for model selections that disappear from a catalog.
                if (selection.configId !== "mode") {
                    continue;
                }
                const current = this.#configOptions.find((option) => option.id === selection.configId);
                if (
                    current?.type !== selection.type ||
                    (current.type === "select" && selection.type === "select"
                        ? current.currentValue !== selection.value
                        : current.type === "boolean" &&
                          selection.type === "boolean" &&
                          current.booleanValue !== selection.booleanValue)
                ) {
                    throw new AcpExecutionError(
                        "The Agent could not preserve the source Session mode for this Fork",
                        {},
                        "invalid_session_configuration",
                    );
                }
            }
        }
    };

    readonly #applySessionOpened = (opened: AdapterSessionOpened): void => {
        this.#agentName = opened.agentName;
        this.#agentVersion = opened.agentVersion;
        this.#modelEffort = opened.agentSettingsModelEffort;
        this.#capabilities = opened.capabilities;
        this.#configOptions = opened.configOptions;
    };

    /** Whether a prompt has been handed to the conversation's Agent, by this process or an earlier one. */
    readonly #prompted = (): boolean => this.#identity.kind === "bound" && this.#identity.prompted;

    /** A conversation this process created has no history of its own until its first prompt. */
    readonly #historyIsEmpty = (): boolean =>
        this.#identity.kind === "bound" && this.#identity.origin === "created" && !this.#identity.prompted;

    readonly prepared = (): PreparedSession =>
        new PreparedSession(
            this.#agentName,
            this.#agentVersion,
            this.#capabilities,
            this.#commands,
            this.#configOptions,
            this.#prompted(),
            this.#identity.kind === "bound" && this.#identity.origin !== "created",
            configurationRevision(this.#configOptions),
        );

    readonly ensureHistoryLoaded = async (signal: AbortSignal): Promise<void> => {
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        await this.#completedHistory(signal);
    };

    readonly loadHistoryEvents = async (
        eventLimit: number,
        cursor: string | null,
        signal: AbortSignal,
    ): Promise<SessionEventPage> => {
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        const history = await this.#completedHistory(signal);
        return history.eventPage(eventLimit, cursor);
    };

    async #completedHistory(signal: AbortSignal): Promise<HistoryReplayCapture> {
        if (this.#sessionLoad.kind === "loaded") {
            return this.#sessionLoad.history;
        }
        if (this.#sessionLoad.kind === "capturing") {
            const { completion, history } = this.#sessionLoad;
            await waitForSharedOperation(completion, signal);
            return history;
        }
        if (this.#historyIsEmpty()) {
            this.#store.events.reset(this.target);
            return this.#holdHistory(new HistoryReplayCapture(this.#store.events, this.target));
        }
        await this.#replayHistory(signal);
        return await this.#completedHistory(signal);
    }

    readonly #holdHistory = (history: HistoryReplayCapture): HistoryReplayCapture => {
        this.#sessionLoad = { kind: "loaded", history };
        return history;
    };

    /** Opens the conversation with the Agent replaying its history, which this process then holds. */
    readonly #replayHistory = async (signal: AbortSignal): Promise<AdapterSessionOpened> => {
        if (this.#sessionLoad.kind !== "not-requested") {
            throw new AcpExecutionError("The Session history is already loaded", {}, "invalid_agent_session");
        }
        this.#store.events.reset(this.target);
        const history = new HistoryReplayCapture(this.#store.events, this.target, this.#settledTurns());
        const opening = Promise.resolve().then(async (): Promise<AdapterSessionOpened> => {
            try {
                const opened = await this.#writeNativeHistory(
                    async () =>
                        await this.#adapter.openSessionWithReplay({
                            ...this.#sessionParams(signal),
                            sessionId: this.target.sessionId,
                        }),
                );
                signal.throwIfAborted();
                this.#capabilities = opened.capabilities;
                history.finishReplay();
                this.#holdHistory(history);
                return opened;
            } catch (cause) {
                this.#sessionLoad = { kind: "not-requested" };
                throw cause;
            }
        });
        this.#sessionLoad = { kind: "capturing", history, completion: opening };
        return await opening;
    };

    /** Reopens the established conversation the Runtime recorded or an import names. */
    readonly #restore = async (
        signal: AbortSignal,
        recovery: SessionRecovery,
        origin: NativeSessionOrigin | undefined,
    ): Promise<void> => {
        const conversation = this.#metrics.measureSync("session-state-read", () =>
            restoredConversation(
                origin === undefined ? this.#store.read(this.target) : undefined,
                this.target,
                this.#cwd,
                origin,
                new Date().toISOString(),
            ),
        );
        this.#bind(conversation.target, "reopened", conversation.prompted);
        this.#sessionTitle = conversation.title;
        const opening = restoreOpening(recovery, this.#capabilities);
        const opened = await this.#metrics.measure("session-load", async () =>
            opening === "replay"
                ? await this.#replayHistory(signal)
                : await this.#adapter.openSession({ ...this.#sessionParams(signal), sessionId: this.target.sessionId }),
        );
        if (opened.sessionId !== conversation.sessionId) {
            throw new AcpExecutionError(
                "The harness restored a different native Session",
                {},
                "invalid_native_session_response",
            );
        }
        this.#applySessionOpened(opened);
        await this.#restoreStoredConfigurations(conversation, signal);
        signal.throwIfAborted();
        this.writeStoredSession(conversation.updatedAt);
    };

    /**
     * Native clients, such as the Agent's own terminal, can continue the conversation
     * while this process is idle. The Agent would then answer from, and append to, the
     * copy it loaded earlier, so the caller must reopen the conversation from native history.
     */
    readonly nativeHistoryChanged = async (signal: AbortSignal): Promise<boolean> => {
        const baseline = this.#nativeHistoryBaseline;
        if (this.#writingNativeHistory()) {
            return false;
        }
        switch (baseline.kind) {
            case "unavailable":
                return false;
            case "recording":
                await waitForSharedOperation(baseline.completion, signal);
                return await this.nativeHistoryChanged(signal);
            case "recorded": {
                let current: NativeHistoryRevision;
                try {
                    current = await this.#readNativeHistoryRevision(signal);
                } catch (error) {
                    signal.throwIfAborted();
                    console.warn(`[${this.#harness}-acp] Native history revision could not be read`, error);
                    return false;
                }
                // Our own writes that began meanwhile record a new baseline when they settle.
                return (
                    !this.#writingNativeHistory() &&
                    this.#nativeHistoryBaseline === baseline &&
                    current.kind === "tracked" &&
                    current.latestEntryId !== baseline.latestEntryId
                );
            }
            default: {
                const unreachable: never = baseline;
                throw new AcpExecutionError("Unexpected native history baseline", { cause: unreachable });
            }
        }
    };

    readonly #writingNativeHistory = (): boolean =>
        this.#nativeHistoryWrites > 0 || this.#backgroundActivity !== "none";

    /**
     * Runs an operation that may append to native history, then records what it left there.
     * The recording starts synchronously; a later comparison waits for it instead of the operation.
     */
    readonly #writeNativeHistory = async <T>(operation: () => Promise<T>): Promise<T> => {
        this.#nativeHistoryWrites += 1;
        try {
            return await operation();
        } finally {
            this.#nativeHistoryWrites -= 1;
            void this.#recordNativeHistoryRevision();
        }
    };

    readonly #readNativeHistoryRevision = async (signal: AbortSignal): Promise<NativeHistoryRevision> =>
        this.#identity.kind === "bound"
            ? await this.#adapter.readNativeHistoryRevision({
                  ...this.#target(),
                  signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              })
            : { kind: "untracked" };

    readonly #recordNativeHistoryRevision = async (): Promise<void> => {
        if (this.#writingNativeHistory()) {
            return;
        }
        const recorded = Promise.withResolvers<void>();
        const recording: NativeHistoryBaseline = { kind: "recording", completion: recorded.promise };
        this.#nativeHistoryBaseline = recording;
        let baseline: NativeHistoryBaseline = { kind: "unavailable" };
        try {
            const revision = await this.#readNativeHistoryRevision(AbortSignal.timeout(30_000));
            if (revision.kind === "tracked") {
                baseline = { kind: "recorded", latestEntryId: revision.latestEntryId };
            }
        } catch (error) {
            // A released process has no writer left to compare; any other failure keeps reuse unchanged.
            if (!(error instanceof AcpExecutionError && error.code === "invalid_agent_session")) {
                console.warn(`[${this.#harness}-acp] Native history revision could not be recorded`, error);
            }
        } finally {
            if (this.#nativeHistoryBaseline === recording) {
                this.#nativeHistoryBaseline = baseline;
            }
            recorded.resolve();
        }
    };

    readonly #applyConfiguration = async (
        selection: SessionConfigurationSelection,
        signal: AbortSignal,
    ): Promise<void> => {
        const before = this.#configOptions;
        const configured = await this.#writeNativeHistory(
            async () => await this.#adapter.configureSession({ ...this.#target(), selection, signal }),
        );
        // An Agent update that arrived meanwhile is newer than this response.
        if (this.#configOptions === before) {
            this.#configOptions = configured;
            await this.#publishConfiguration();
        }
    };

    // The revision check and Agent mutation share one queue with the settings the Runtime applies itself.
    // A lost response may have committed: reread after a conflict, never replay an edit blindly.
    readonly configure = async (options: SessionConfigureOptions): Promise<SessionConfigurationSnapshot> =>
        this.#configurationChanges.run(async (signal) => {
            if (options.expectedConfigurationRevision !== configurationRevision(this.#configOptions)) {
                throw new AcpExecutionError(
                    "Session settings changed. Review the current settings before applying your selection again.",
                    {},
                    "session_configuration_conflict",
                );
            }
            return await this.#change(options, signal);
        }, options.signal);

    /** Applies a setting the Runtime owns, whatever the configuration's current revision. */
    readonly applyConfiguration = async (change: SessionConfigurationChange): Promise<SessionConfigurationSnapshot> =>
        this.#configurationChanges.run(async (signal) => await this.#change(change, signal), change.signal);

    readonly #change = async (
        change: SessionConfigurationChange,
        signal: AbortSignal,
    ): Promise<SessionConfigurationSnapshot> => {
        await this.#applyConfiguration(
            change.type === "boolean"
                ? { type: "boolean", configId: change.configId, booleanValue: change.booleanValue }
                : { type: "select", configId: change.configId, value: change.value },
            signal,
        );
        const applied = this.#configOptions.find((option) => option.id === change.configId);
        if (applied === undefined) {
            throw new AcpExecutionError("The requested ACP configuration option is unavailable");
        }
        this.#sessionConfigurations.select(applied);
        this.writeStoredSession(new Date().toISOString());
        return {
            configOptions: this.#configOptions,
            configurationRevision: configurationRevision(this.#configOptions),
        };
    };

    readonly #publishConfiguration = async (): Promise<void> => {
        // Use the existing v2 ACP event vocabulary so old observers can still decode the stream.
        const event = this.#store.events.append(this.target, {
            type: "acp",
            payload: {
                sessionUpdate: "config_option_update",
                configOptions: this.#configOptions.map((option) => ({
                    category: option.category,
                    description: option.description,
                    id: option.id,
                    name: option.name,
                    ...(option.type === "boolean"
                        ? { type: "boolean" as const, currentValue: option.booleanValue }
                        : { type: "select" as const, currentValue: option.currentValue, options: option.values }),
                })),
            },
        });
        await this.#observer.onSessionEvent?.(event);
    };

    readonly #target = (): AdapterSessionTarget => ({
        sessionId: this.#bound().target.sessionId,
        cwd: this.#cwd,
    });

    readonly #bound = (): Extract<NativeIdentity, { readonly kind: "bound" }> => {
        if (this.#identity.kind !== "bound") {
            throw new AcpExecutionError("The harness has not established a Session", {}, "invalid_agent_session");
        }
        return this.#identity;
    };

    /** Loads what the Agent needs before it can receive a prompt; the Agent does not receive it yet. */
    readonly preparePrompt = async (signal: AbortSignal): Promise<void> => {
        if (this.#capabilities.loadSession) {
            await this.#completedHistory(signal);
        } else if (this.#sessionLoad.kind === "not-requested") {
            // The Agent keeps no history to replay; the Runtime's own record of the Session continues as it is.
            this.#holdHistory(new HistoryReplayCapture(this.#store.events, this.target));
        }
    };

    /**
     * Hands a prepared prompt to the Agent. Precondition: `preparePrompt` completed and the Session's execution
     * authority records this command as started. `cancellationRequested` reads that authority's cancellation of it.
     */
    readonly prompt = async (
        options: SessionTurnOptions & { readonly cancellationRequested: () => boolean },
    ): Promise<PromptResult> => {
        validatePromptContent(options, this.#capabilities);
        // Recording prompt.started below is the command's start; a cancellation that arrived first withdraws it.
        options.signal.throwIfAborted();
        if (this.#sessionTitle.length === 0) {
            this.#sessionTitle = conversationTitleFromText(options.prompt);
        }
        this.#identity = { ...this.#bound(), prompted: true };
        this.writeStoredSession(new Date().toISOString());
        const lifecycle = options.lifecycle;
        if (lifecycle !== undefined) {
            await this.recordLifecycleEvent({
                payload: {
                    commandId: options.commandId,
                    content: lifecycle.content,
                    ...(lifecycle.disposition === undefined ? {} : { disposition: lifecycle.disposition }),
                    kind: "prompt.requested",
                    ...(lifecycle.context === undefined ? {} : { context: lifecycle.context }),
                    ...(lifecycle.targetCommandId === undefined ? {} : { targetCommandId: lifecycle.targetCommandId }),
                },
                type: "lifecycle-metadata",
            });
            await this.recordLifecycleEvent({
                payload: {
                    attemptId: lifecycle.attemptId,
                    commandId: options.commandId,
                    epoch: lifecycle.epoch,
                    kind: "prompt.started",
                },
                type: "lifecycle-metadata",
            });
        }
        this.#delegableCommandId = lifecycle === undefined ? null : options.commandId;
        try {
            const result = await this.#writeNativeHistory(async () => {
                try {
                    return await this.#adapter.prompt({ ...this.#target(), content: options, signal: options.signal });
                } finally {
                    // The prompt's terminal event follows; nothing may be recorded for it after that.
                    this.#delegableCommandId = null;
                }
            });
            this.writeStoredSession(new Date().toISOString());
            if (lifecycle !== undefined) {
                const messageId = result._meta?.messageId;
                await this.recordLifecycleEvent({
                    payload: {
                        commandId: options.commandId,
                        kind: "prompt.completed",
                        ...(messageId === undefined ? {} : { messageId }),
                        stopReason: result.stopReason,
                    },
                    type: "lifecycle-metadata",
                });
            }
            return result;
        } catch (error) {
            const failure =
                error instanceof AcpExecutionError
                    ? error
                    : new AcpExecutionError("ACP agent execution failed", { cause: error });
            if (lifecycle !== undefined) {
                const message = failure instanceof AcpPromptExecutionError ? { messageId: failure.messageId } : {};
                await this.recordLifecycleEvent({
                    payload: options.cancellationRequested()
                        ? {
                              commandId: options.commandId,
                              kind: "prompt.completed",
                              ...message,
                              stopReason: "cancelled",
                          }
                        : {
                              attemptId: lifecycle.attemptId,
                              code: failure.code,
                              commandId: options.commandId,
                              kind: "prompt.failed",
                              message: truncate(failure.message, 500),
                              ...message,
                          },
                    type: "lifecycle-metadata",
                });
            }
            if (error instanceof AcpExecutionError) {
                throw error;
            }
            throw failure;
        }
    };

    /**
     * Adds a steering prompt to the prompt the Agent holds. Precondition: the Session's execution authority accepts
     * steering into `options.targetCommandId`.
     */
    readonly steer = async (options: SessionSteerOptions): Promise<string> => {
        if (!this.#capabilities.steering) {
            throw new AcpExecutionError(
                "The selected agent does not support mid-turn steering",
                {},
                "steering_unsupported",
            );
        }
        validatePromptContent(options, this.#capabilities);
        // Recording prompt.started below is the command's start; a cancellation that arrived first withdraws it.
        options.signal.throwIfAborted();
        const lifecycle = options.lifecycle;
        if (lifecycle !== undefined) {
            await this.recordLifecycleEvent({
                payload: {
                    commandId: options.commandId,
                    content: lifecycle.content,
                    ...(lifecycle.disposition === undefined ? {} : { disposition: lifecycle.disposition }),
                    kind: "prompt.requested",
                    ...(lifecycle.context === undefined ? {} : { context: lifecycle.context }),
                    ...(lifecycle.targetCommandId === undefined ? {} : { targetCommandId: lifecycle.targetCommandId }),
                },
                type: "lifecycle-metadata",
            });
            await this.recordLifecycleEvent({
                payload: {
                    attemptId: lifecycle.attemptId,
                    commandId: options.commandId,
                    epoch: lifecycle.epoch,
                    kind: "prompt.started",
                },
                type: "lifecycle-metadata",
            });
        }
        try {
            const outcome = await this.#adapter.steer({ ...this.#target(), content: options, signal: options.signal });
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload: {
                        commandId: options.commandId,
                        kind: "prompt.completed",
                        // The steering's own user message, so a reloaded history shows it inside the turn it joined.
                        ...(outcome.outcome === "injected" && outcome.messageId !== undefined
                            ? { messageId: outcome.messageId }
                            : {}),
                        stopReason: "steered",
                    },
                    type: "lifecycle-metadata",
                });
            }
            return outcome.outcome;
        } catch (error) {
            const failure =
                error instanceof AcpExecutionError
                    ? error
                    : new AcpExecutionError("ACP agent execution failed", { cause: error });
            if (lifecycle !== undefined) {
                await this.recordLifecycleEvent({
                    payload: {
                        attemptId: lifecycle.attemptId,
                        code: failure.code,
                        commandId: options.commandId,
                        kind: "prompt.failed",
                        message: truncate(failure.message, 500),
                    },
                    type: "lifecycle-metadata",
                });
            }
            throw failure;
        }
    };

    readonly cancel = async (signal: AbortSignal): Promise<"retained" | "closed"> => {
        signal.throwIfAborted();
        await this.#interactions.cancelPendingInteractions();
        signal.throwIfAborted();
        if (this.#agentCommand() !== undefined) {
            return await this.#adapter.cancel({ ...this.#target(), signal });
        }
        return "retained";
    };

    readonly interactionSnapshot = (): SessionInteractionSnapshot => {
        const { sessionGenerationId, throughPosition } = this.#store.events.livePosition(this.target);
        return { sessionGenerationId, throughPosition, interactions: this.#interactions.snapshot() };
    };

    readonly respondPermission = async (options: PermissionResponseOptions): Promise<void> => {
        await this.#interactions.respondPermission(options);
    };
    readonly respondElicitation = async (options: ElicitationResponseOptions): Promise<void> => {
        await this.#interactions.respondElicitation(options);
    };

    readonly recordControlEvent = async (event: SessionEventPayload): Promise<boolean> => {
        if (this.#sessionLoad.kind !== "loaded") {
            return false;
        }
        await this.recordLifecycleEvent(event);
        return true;
    };

    readonly recordLifecycleEvent = async (event: SessionEventPayload): Promise<void> => {
        if (event.type !== "lifecycle-metadata" || this.#sessionLoad.kind !== "loaded") {
            return;
        }
        const liveEvent = this.#sessionLoad.history.recordLifecycle(event);
        await this.#observer.onSessionEvent?.(liveEvent);
    };

    /**
     * Takes the native Session the harness names. A created or forked conversation takes a new identity the Runtime
     * does not hold yet; a reopened one must be the target it was expected under; a bound one never changes.
     */
    readonly #adoptNativeSession = (sessionId: string): void => {
        const identity = this.#identity;
        switch (identity.kind) {
            case "awaiting": {
                const target = { harness: this.#harness, sessionId };
                if (!isIdentifier(sessionId) || this.#store.read(target) !== undefined) {
                    throw new AcpExecutionError(
                        "The Agent returned an invalid new Session ID",
                        {},
                        "invalid_native_session_response",
                    );
                }
                this.#bind(target, identity.origin, identity.origin === "forked");
                return;
            }
            case "expected":
                if (!sameNativeSession(identity.target, { harness: this.#harness, sessionId })) {
                    throw new AcpExecutionError(
                        "The harness returned a different native Session",
                        {},
                        "session_identity_mismatch",
                    );
                }
                return;
            case "bound":
                this.assertNativeSession(sessionId);
                return;
            default: {
                const unreachable: never = identity;
                throw new AcpExecutionError("Unexpected native identity", { cause: unreachable });
            }
        }
    };

    readonly #bind = (target: NativeSessionTarget, origin: SessionOrigin, prompted: boolean): void => {
        if (this.#identity.kind === "expected" && !sameNativeSession(this.#identity.target, target)) {
            throw new AcpExecutionError(
                "The harness returned a different native Session",
                {},
                "session_identity_mismatch",
            );
        }
        if (this.#identity.kind === "bound") {
            throw new AcpExecutionError(
                "ACP agent attempted to replace the selected session",
                {},
                "invalid_agent_session",
            );
        }
        this.#identity = { kind: "bound", target, origin, prompted };
    };

    readonly #processEvent = async (event: NativeSessionEvent): Promise<void> => {
        if (event.kind === "configuration" || event.kind === "mode") {
            this.#configOptions =
                event.kind === "configuration"
                    ? event.configOptions
                    : this.#configOptions.map((option) =>
                          option.category === "mode" ? { ...option, currentValue: event.modeId } : option,
                      );
            this.#captureSelectedConfigurationValues();
        }
        if (this.#sessionLoad.kind === "capturing") {
            this.#sessionLoad.history.replay(event.payload);
        } else if (this.#sessionLoad.kind === "loaded") {
            await this.#sessionLoad.history.record(event.payload, async (liveEvent) => {
                await this.#observer.onSessionEvent?.(liveEvent);
            });
        }
        switch (event.kind) {
            case "content":
            case "other":
                return;
            case "commands":
                this.#commands = event.commands;
                return;
            case "configuration":
            case "mode":
                return;
            case "info": {
                for (const change of event.changes) {
                    switch (change.kind) {
                        case "title":
                            this.#sessionTitle = change.value;
                            break;
                        case "updated-at":
                            // An empty time is the Agent clearing it.
                            this.#sessionUpdatedAt = change.value.length > 0 ? change.value : null;
                            break;
                    }
                }
                const updatedAt = this.#sessionUpdatedAt ?? new Date().toISOString();
                if (this.#identity.kind === "bound") {
                    this.writeStoredSession(updatedAt);
                }
                return;
            }
        }
    };

    readonly close = async (): Promise<void> => {
        try {
            await this.#interactions.cancelPendingInteractions();
        } catch (error) {
            try {
                throw error;
            } finally {
                await this.closeProcess();
            }
        }
        if (this.#identity.kind !== "bound") {
            await this.closeProcess();
            return;
        }
        await this.#adapter.closeSession({ ...this.#target(), signal: AbortSignal.timeout(30_000) });
    };

    readonly closeProcess = async (): Promise<void> => {
        if (this.#identity.kind === "bound") {
            await this.#adapter.releaseSession({ ...this.#target(), signal: AbortSignal.timeout(30_000) });
        }
        this.#backgroundActivity = "none";
    };

    readonly agentSettingsModelEffort = () => this.#modelEffort;
    readonly #sessionParams = (signal: AbortSignal): AdapterSessionCreateParams => ({
        ...this.#subscriber,
        scope: this.#scope,
        signal,
    });
    readonly assertNativeSession = (sessionId: string): void => {
        if (this.#identity.kind !== "bound" || sessionId !== this.#identity.target.sessionId) {
            throw new AcpExecutionError("ACP agent referenced an unknown session", {}, "invalid_agent_session");
        }
    };
}
