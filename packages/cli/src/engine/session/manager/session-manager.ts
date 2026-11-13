import { NativeSessionMap, nativeSessionKey } from "@morty-build/client/native-session";
import {
    isIdentifier,
    type LastTurnOutcome,
    type NativeSessionTarget,
    SESSION_CLOSE_NOTICE_KIND,
    type SessionCapabilities,
    type SessionCloseNoticeEvent,
    type SessionEventPayload,
    type SessionInteractionSnapshot,
    type SessionStatus,
} from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";
import { unsupportedSessionCapabilities } from "../../acp/protocol/session-capabilities.ts";
import { type OperationMetrics, unmeasuredOperationMetrics } from "../../infra/operation-metrics.ts";
import type { Timer } from "../../util/timer.ts";
import { AgentSession, type SessionExecutionRecord } from "../live/agent-session.ts";
import { replaySessionConfigurations, storedSessionConfiguration } from "../live/session-configurations.ts";
import { nativeSessionQuery } from "../native/native-query.ts";
import type { AgentProcessPool, AgentProcessRetention } from "../process/agent-process-pool.ts";
import { RetainedAgentProcesses } from "../process/retained-agent-processes.ts";
import { MemorySessionStore, type SessionStore, type StoredSession } from "../record/session-store.ts";
import { isModelOption } from "../settings/configuration-dependencies.ts";
import { ActiveExecutions } from "../turn/active-executions.ts";
import type { SettledTurn } from "../turn/execution-receipts.ts";
import { RuntimeOperations, waitForSharedOperation } from "./operation-drain.ts";
import {
    type ImmediateSessionOperation,
    SessionLifecycles,
    type WaitingSessionOperation,
} from "./session-lifecycle.ts";

const SESSION_CONTROL_TIMEOUT_MILLISECONDS = 30_000;
const SESSION_CLOSE_TIMEOUT_MILLISECONDS = 30_000;

import {
    type AgentSettingsInspectionOptions,
    AgentSettingsSnapshot,
    type ElicitationResponseOptions,
    NullSessionObserver,
    type PermissionResponseOptions,
    type PreparedSession,
    type PromptResult,
    type ResolveAgent,
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

export class SessionManager {
    readonly #operations = new RuntimeOperations();
    readonly #processes: AgentProcessPool;
    readonly #executionProcesses = new RetainedAgentProcesses<AgentSession, NativeSessionTarget>(
        {
            touch: (runtime) => this.#processes.touch(runtime),
            changed: () => this.#processes.notifyChanged(),
        },
        nativeSessionKey,
    );
    readonly #executions: ActiveExecutions;
    readonly #settledTurns: (target: NativeSessionTarget) => readonly SettledTurn[];
    readonly #executionRecord: SessionExecutionRecord = {
        agentCommand: (target) => this.#executions.agentCommand(target),
        settledTurns: (target) => this.#settledTurns(target),
    };
    readonly #lastTurn: (target: NativeSessionTarget) => LastTurnOutcome | undefined;
    readonly #agentSettingsObserver = new NullSessionObserver();
    readonly #lifecycles = new SessionLifecycles();
    readonly #sessionRetirements = new NativeSessionMap<Promise<void>>();
    readonly #store: SessionStore;
    readonly #onSessionClosed: (event: SessionCloseNoticeEvent) => void;
    readonly #timer: Timer;
    readonly #observer: SessionObserver;

    constructor({
        observer,
        store,
        processes,
        onSessionClosed,
        lastTurn,
        settledTurns,
        timer,
    }: {
        readonly observer: SessionObserver;
        readonly store: SessionStore;
        readonly processes: AgentProcessPool;
        /** Called once each time a Session becomes closed, so every client learns of it. */
        readonly onSessionClosed: (event: SessionCloseNoticeEvent) => void;
        /** How the Session's most recent started command ended, as the execution receipts retain it. */
        readonly lastTurn: (target: NativeSessionTarget) => LastTurnOutcome | undefined;
        /** The Session's settled turns the execution receipts retain, which a replayed history places. */
        readonly settledTurns: (target: NativeSessionTarget) => readonly SettledTurn[];
        readonly timer: Timer;
    }) {
        this.#observer = observer;
        this.#processes = processes;
        this.#store = store;
        this.#lastTurn = lastTurn;
        this.#settledTurns = settledTurns;
        this.#executions = new ActiveExecutions();
        this.#onSessionClosed = onSessionClosed;
        this.#timer = timer;
    }

    readonly recordLifecycleEvent = async (
        target: NativeSessionTarget,
        event: SessionEventPayload,
    ): Promise<boolean> => {
        const runtime = this.#executionProcesses.get(target);
        if (runtime === undefined) {
            return false;
        }
        return await runtime.recordControlEvent(event);
    };

    #isHeld(target: NativeSessionTarget): boolean {
        return this.#store.read(target) !== undefined;
    }

    /** Admits an operation the lifecycle rule answers at once; a refusal throws its typed error. */
    #admitNow(target: NativeSessionTarget, operation: ImmediateSessionOperation): void {
        const admission = this.#lifecycles.admitNow(target, operation, () => this.#isHeld(target));
        if (admission.kind === "refused") {
            throw admission.error;
        }
    }

    /**
     * Admits an operation once any creation or closing it waits for settled. `admitted` runs synchronously with the
     * decision, so the transition it makes cannot be separated from the check by another caller.
     */
    async #admit<Result>(
        target: NativeSessionTarget,
        operation: WaitingSessionOperation,
        signal: AbortSignal,
        admitted: () => Result,
    ): Promise<Result> {
        for (;;) {
            const admission = this.#lifecycles.admit(target, operation, () => this.#isHeld(target));
            switch (admission.kind) {
                case "admitted":
                    return admitted();
                case "refused":
                    throw admission.error;
                case "wait":
                    await waitForSharedOperation(admission.settled, signal);
                    break;
                default: {
                    const unreachable: never = admission;
                    throw new Error("Unexpected Session admission", { cause: unreachable });
                }
            }
        }
    }

    #retention(target: NativeSessionTarget): AgentProcessRetention<AgentSession> {
        return {
            isBusy: () =>
                this.#executionProcesses.get(target)?.hasBackgroundActivity() === true ||
                this.#executions.isBusy(target) ||
                this.#executionProcesses.isBusy(target) ||
                this.#lifecycles.managesNativeSession(target),
            retire: (runtime) => this.#retireSessionProcess(target, runtime, () => runtime.close()),
            retireIdle: (runtime) => this.#stopSessionProcess(target, runtime),
        };
    }

    /**
     * Retires a Session's process. The stored Session outlives it, whatever ended the process: only an operation
     * that ends the Session itself removes its title, settings and native identity.
     */
    async #retireSessionProcess(
        target: NativeSessionTarget,
        runtime: AgentSession,
        close: () => Promise<void>,
    ): Promise<void> {
        this.#executionProcesses.detach(target, runtime);
        await this.#processes.retire(runtime, close);
    }

    /**
     * Releases a closed or idle Session's process while keeping its title, settings and native
     * identity available for the next preparation. This does not mark the Session closed.
     */
    async #stopSessionProcess(target: NativeSessionTarget, runtime: AgentSession): Promise<void> {
        this.#executionProcesses.detach(target, runtime);
        const retirement = this.#processes.retire(runtime, () => runtime.close());
        this.#sessionRetirements.set(target, retirement);
        try {
            await retirement;
        } finally {
            if (this.#sessionRetirements.get(target) === retirement) {
                this.#sessionRetirements.delete(target);
            }
        }
    }

    #isKnownSession(target: NativeSessionTarget): boolean {
        return (
            this.#executionProcesses.get(target) !== undefined ||
            this.#executionProcesses.pending(target) !== undefined ||
            this.#isHeld(target)
        );
    }

    async #startRetainedSessionProcess(
        options: SessionPrepareOptions,
        start: (capabilities: SessionCapabilities) => Promise<AgentSession>,
    ): Promise<AgentSession> {
        const retiring = this.#sessionRetirements.get(options.target);
        if (retiring !== undefined) {
            // The old process may still own the native writer while graceful teardown runs.
            await waitForSharedOperation(retiring, options.signal);
        }
        const stored = this.#store.read(options.target);
        // Discovery may acquire a pooled reader: do it before reserving execution capacity.
        const capabilities =
            options.origin !== undefined || stored !== undefined
                ? await options.adapter.getCapabilities(nativeSessionQuery(options))
                : unsupportedSessionCapabilities();
        const runtime = await this.#processes.startRetained(
            options.signal,
            () => start(capabilities),
            this.#retention(options.target),
        );
        this.#executionProcesses.retain(options.target, runtime);
        return runtime;
    }

    async #startPreparation(
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AgentSession> {
        return await this.#executionProcesses.prepare(
            options.target,
            async () => await this.#startSession(options, recovery, metrics),
        );
    }

    /** Starts the Session's process, which the Runtime retains until the Session is stopped or retired. */
    async #startSession(
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AgentSession> {
        return await this.#startRetainedSessionProcess(
            options,
            async (capabilities) =>
                await AgentSession.start(
                    options,
                    recovery,
                    this.#observer,
                    this.#executionRecord,
                    this.#store,
                    metrics,
                    options.adapter,
                    capabilities,
                ),
        );
    }

    async #replaceExecutionPreparation(existing: AgentSession, options: SessionPrepareOptions): Promise<AgentSession> {
        const desiredConfigOptions = existing.prepared().configOptions;
        const recovery: SessionRecovery = options.recovery ?? { kind: "interactive-only" };
        return await this.#executionProcesses.prepare(options.target, async () => {
            await this.#retireSessionProcess(options.target, existing, async () => await existing.close());
            const runtime = await this.#startSession(options, recovery);
            try {
                await replaySessionConfigurations(
                    desiredConfigOptions.map(storedSessionConfiguration),
                    () => runtime.prepared().configOptions,
                    async (desired) => {
                        await runtime.applyConfiguration({
                            ...options,
                            booleanValue: desired.type === "boolean" && desired.booleanValue,
                            configId: desired.configId,
                            requestId: `execution-prepare-${desired.configId}`,
                            value: desired.type === "select" ? desired.value : "",
                            valueType: desired.type,
                        });
                    },
                    options.signal,
                );
            } catch (error) {
                await this.#retireSessionProcess(options.target, runtime, async () => await runtime.close());
                throw error;
            }
            return runtime;
        });
    }

    /**
     * Reuses an idle process only while it still continues the latest native conversation.
     * Otherwise its Agent would answer from, and append to, an earlier copy, so the process is
     * released and the Session reopens from native history as after idle reclamation.
     */
    async #currentSessionProcess(
        existing: AgentSession,
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
    ): Promise<AgentSession> {
        const changed =
            !this.#lifecycles.managesNativeSession(options.target) &&
            (await existing.nativeHistoryChanged(options.signal));
        // Another operation may have reopened the Session while the native history was read.
        const pending = this.#executionProcesses.pending(options.target);
        if (pending !== undefined) {
            return await waitForSharedOperation(pending, options.signal);
        }
        const current = this.#executionProcesses.get(options.target);
        if (current !== undefined && current !== existing) {
            return current;
        }
        if (!changed) {
            return existing;
        }
        return await this.#executionProcesses.prepare(options.target, async () => {
            await this.#stopSessionProcess(options.target, existing);
            return await this.#startSession(options, recovery);
        });
    }

    async #prepareSession(
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<PreparedSession> {
        return await this.#executionProcesses.use(options.target, async () =>
            this.#operations.run(options, async (options) => {
                await this.#admit(options.target, { kind: "prepare" }, options.signal, () => undefined);
                const pending = this.#executionProcesses.pending(options.target);
                if (pending !== undefined) {
                    const runtime = await metrics.measure(
                        "session-preparation-wait",
                        async () => await waitForSharedOperation(pending, options.signal),
                    );
                    if (runtime.runsIn(options.cwd)) {
                        this.#executionProcesses.touch(options.target, runtime);
                        if (recovery.kind === "history-required") {
                            await metrics.measure(
                                "session-load",
                                async () => await runtime.ensureHistoryLoaded(options.signal),
                            );
                        }
                        return runtime.prepared();
                    }
                    return await this.#prepareSession(options, recovery, metrics);
                }
                const existing = this.#executionProcesses.get(options.target);
                if (existing !== undefined) {
                    if (existing.runsIn(options.cwd)) {
                        const runtime = await this.#currentSessionProcess(existing, options, recovery);
                        this.#executionProcesses.touch(options.target, runtime);
                        if (recovery.kind === "history-required") {
                            await metrics.measure(
                                "session-load",
                                async () => await runtime.ensureHistoryLoaded(options.signal),
                            );
                        }
                        return runtime.prepared();
                    }
                    throw new AcpExecutionError(
                        "The native Session's workspace cannot change",
                        {},
                        "session_identity_mismatch",
                    );
                }
                const runtime = await this.#startPreparation(options, recovery, metrics);
                return runtime.prepared();
            }),
        );
    }

    readonly prepareSession = async (
        options: SessionPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<PreparedSession> => await this.#prepareSession(options, { kind: "interactive-only" }, metrics);

    /**
     * Creates a Session with the initial settings `configure` applies, and answers with the configured snapshot. A
     * Session this call created that cannot take its settings is discarded, so a refused creation leaves nothing
     * behind. A Session that already existed, such as one whose creation answer was lost, is configured again and kept.
     * Concurrent creates are busy until initialization and cleanup finish; none may acknowledge a Session another
     * creation can still discard.
     */
    readonly createSession = async (
        options: SessionPrepareOptions,
        configure: (prepared: PreparedSession, signal: AbortSignal) => Promise<void>,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<PreparedSession> =>
        this.#operations.run(options, async (options) => {
            const creation = Promise.withResolvers<void>();
            const created = await this.#admit(options.target, { kind: "create" }, options.signal, () => {
                const unknown = !this.#isKnownSession(options.target);
                this.#lifecycles.beginCreation(options.target, creation.promise);
                return unknown;
            });
            try {
                await configure(await this.prepareSession(options, metrics), options.signal);
                return await this.prepareSession(options, metrics);
            } catch (error) {
                if (created) {
                    await this.#discardCreatedSession(options.target);
                }
                throw error;
            } finally {
                this.#lifecycles.endCreation(options.target, creation.promise);
                creation.resolve();
            }
        });

    async #discardCreatedSession(target: NativeSessionTarget): Promise<void> {
        const runtime = this.#executionProcesses.get(target);
        try {
            if (runtime !== undefined) {
                await this.#retireSessionProcess(target, runtime, async () => await runtime.close());
            }
        } finally {
            this.#store.remove(target);
        }
    }

    readonly restoreSession = async (
        options: SessionPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<PreparedSession> => await this.#prepareSession(options, { kind: "history-required" }, metrics);

    /**
     * Opens a short-lived native ACP session only to read the local Agent's
     * authoritative settings. Its identity and store are private to this
     * operation and never become a Morty Session.
     */
    readonly inspectAgentSettings = async (options: AgentSettingsInspectionOptions): Promise<AgentSettingsSnapshot> =>
        this.#operations.run(options, async (options) => {
            return await this.#processes.runTransient(
                options.signal,
                async () =>
                    await AgentSession.create(
                        options,
                        this.#agentSettingsObserver,
                        { agentCommand: () => undefined, settledTurns: () => [] },
                        new MemorySessionStore(),
                        unmeasuredOperationMetrics,
                    ),
                async (runtime) => {
                    const prepared = runtime.prepared();
                    const discoveredModelEffort = runtime.agentSettingsModelEffort();
                    const model = options.model;
                    const modelOption = prepared.configOptions.find(isModelOption);
                    // A Session cannot switch a model select with a single value, and the
                    // Agent already reported its settings for that current model.
                    const modelIsFixed =
                        modelOption?.type === "select" &&
                        modelOption.values.length < 2 &&
                        modelOption.currentValue === model;
                    const configOptions =
                        model === undefined || modelIsFixed
                            ? prepared.configOptions
                            : (
                                  await runtime.applyConfiguration({
                                      ...options,
                                      booleanValue: false,
                                      configId: modelOption?.id ?? "model",
                                      requestId: "agent-settings-model",
                                      target: runtime.target,
                                      value: model,
                                      valueType: "select",
                                  })
                              ).configOptions;
                    return new AgentSettingsSnapshot(
                        prepared.agentName,
                        prepared.agentVersion,
                        configOptions,
                        discoveredModelEffort === null
                            ? { kind: "unavailable" }
                            : { kind: "complete", value: discoveredModelEffort },
                    );
                },
                async (runtime) => await runtime.close(),
            );
        });

    readonly prepareExecutionSession = async (options: SessionPrepareOptions): Promise<PreparedSession> =>
        this.#operations.run(options, async (options) => {
            const recovery: SessionRecovery = options.recovery ?? { kind: "interactive-only" };
            this.#admitNow(options.target, { kind: "prepare-execution" });
            const pending = this.#executionProcesses.pending(options.target);
            if (pending !== undefined) {
                await waitForSharedOperation(pending, options.signal);
                return await this.prepareExecutionSession(options);
            }
            const existing = this.#executionProcesses.get(options.target);
            if (existing === undefined) {
                return (await this.#startPreparation(options, recovery)).prepared();
            }
            if (!existing.runsIn(options.cwd)) {
                throw new AcpExecutionError(
                    "The workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            if (existing.usesEnvironment(options.agent.environment)) {
                const runtime = await this.#currentSessionProcess(existing, options, recovery);
                this.#executionProcesses.touch(options.target, runtime);
                return runtime.prepared();
            }
            if (this.#executions.isBusy(options.target)) {
                throw new AcpExecutionError(
                    "The execution environment cannot change while a conversation turn is running",
                    {},
                    "session_busy",
                );
            }
            return (await this.#replaceExecutionPreparation(existing, options)).prepared();
        });

    /** Applies a client's edit only while the Session's configuration still has the revision the client read. */
    readonly configureSession = async (options: SessionConfigureOptions): Promise<SessionConfigurationSnapshot> =>
        this.#operations.run(options, async (options) => {
            return await this.#executionProcesses.use(options.target, async () => {
                const runtime = await this.ensureSession(options);
                return await runtime.configure(options);
            });
        });

    /** Applies a setting the Runtime owns, such as one a prompt or a preparation requested. */
    readonly applySessionConfiguration = async (
        change: SessionConfigurationChange,
    ): Promise<SessionConfigurationSnapshot> =>
        this.#operations.run(change, async (change) => {
            return await this.#executionProcesses.use(change.target, async () => {
                const runtime = await this.ensureSession(change);
                return await runtime.applyConfiguration(change);
            });
        });

    readonly renameSession = async (
        options: SessionPrepareOptions,
        title: string,
    ): Promise<{ readonly title: string; readonly updatedAt: string }> =>
        await this.#executionProcesses.use(options.target, async () =>
            this.#operations.run(options, async (options) => {
                this.#admitNow(options.target, { kind: "use" });
                // Process reclamation must not turn a native rename into a metadata-only write.
                // Keep the same process borrowed through recovery and the acknowledged rename.
                const existing = this.#executionProcesses.get(options.target);
                if (existing === undefined) {
                    await this.#prepareSession(options, { kind: "interactive-only" });
                } else {
                    await this.#currentSessionProcess(existing, options, { kind: "interactive-only" });
                }
                const runtime = this.#executionProcesses.get(options.target);
                if (runtime === undefined) {
                    throw new AcpExecutionError("ACP session did not start");
                }
                return await runtime.renameSession(title, options.signal);
            }),
        );

    /**
     * Cancels the named command's execution in whatever phase it is: a preparing execution never starts, a started
     * one has its Agent stopped. The cancellation is recorded before this returns; a command that is not executing has
     * nothing to stop.
     */
    readonly cancelPrompt = (
        target: NativeSessionTarget,
        commandId: string,
        signal: AbortSignal = AbortSignal.timeout(30_000),
    ): Promise<void> =>
        this.#executions.cancel(target, commandId, () =>
            this.#operations.run({ signal }, async ({ signal }) => {
                const runtime = this.#executionProcesses.get(target);
                if (runtime !== undefined) {
                    const outcome = await runtime.cancel(signal);
                    switch (outcome) {
                        case "retained":
                            break;
                        case "closed":
                            // Preserve the native conversation and effective settings for
                            // the next prompt, but never reuse a cancelled endpoint.
                            await this.#stopSessionProcess(target, runtime);
                            break;
                        default: {
                            const unreachable: never = outcome;
                            throw new AcpExecutionError("Unexpected cancellation outcome", { cause: unreachable });
                        }
                    }
                }
            }),
        );

    /** Whether the Session began executing the command and still holds it; its cancellation is then the Session's. */
    readonly executes = (target: NativeSessionTarget, commandId: string): boolean =>
        this.#executions.executes(target, commandId);

    /** Whether a steering prompt can join the named execution: the one rule every steering check asks. */
    readonly acceptsSteering = (target: NativeSessionTarget, targetCommandId: string): boolean =>
        this.#executions.acceptsSteering(target, targetCommandId);

    readonly steerPrompt = async (options: SessionSteerOptions): Promise<string> =>
        this.#operations.run(options, async (options) => {
            if (!this.acceptsSteering(options.target, options.targetCommandId)) {
                throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
            }
            const pending = this.#executionProcesses.pending(options.target);
            if (pending !== undefined) {
                await waitForSharedOperation(pending, options.signal);
            }
            // Nothing below awaits before the Agent receives the steer, so this check holds at the handoff.
            if (!this.acceptsSteering(options.target, options.targetCommandId)) {
                throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
            }
            const runtime = this.#executionProcesses.get(options.target);
            if (runtime === undefined || !runtime.runsIn(options.cwd)) {
                throw new AcpExecutionError(
                    "The target turn execution context is unavailable",
                    {},
                    "steering_target_unavailable",
                );
            }
            const deadlineController = new AbortController();
            const deadline = setTimeout(
                () =>
                    deadlineController.abort(
                        new AcpExecutionError("The steering request exceeded its deadline", {}, "steering_timeout"),
                    ),
                SESSION_CONTROL_TIMEOUT_MILLISECONDS,
            );
            deadline.unref();
            try {
                return await runtime.steer({
                    ...options,
                    signal: AbortSignal.any([options.signal, deadlineController.signal]),
                });
            } catch (error) {
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent steering failed", { cause: error }, "steering_failed");
            } finally {
                clearTimeout(deadline);
            }
        });

    readonly runPrompt = async (options: SessionTurnOptions): Promise<PromptResult> =>
        this.#operations.run(options, async (options) => {
            // A close can land after the prompt was prepared; fail before the Session is reported working.
            this.#admitNow(options.target, { kind: "prompt" });
            const preparation = AbortSignal.any([
                options.signal,
                this.#executions.begin(options.target, options.commandId),
            ]);
            // From here on the execution's cancellation is the only one: a cancellation before it began withdrew the
            // prompt before this call.
            const cancelled = (): boolean => this.#executions.cancellationRequested(options.target, options.commandId);
            try {
                const runtime = await this.ensureSession({ ...options, signal: preparation });
                // An import, fork, or history read may have begun while the Agent process was readied.
                this.#admitNow(options.target, { kind: "native-exclusive" });
                if (cancelled()) {
                    return { stopReason: "cancelled" };
                }
                try {
                    await runtime.preparePrompt(preparation);
                    // Nothing awaits between this check and the Agent receiving the prompt.
                    if (cancelled()) {
                        return { stopReason: "cancelled" };
                    }
                    this.#executions.start(options.target, options.commandId);
                    const result = await runtime.prompt({
                        ...options,
                        cancellationRequested: cancelled,
                    });
                    return cancelled() ? { stopReason: "cancelled" } : result;
                } catch (error) {
                    if (cancelled()) {
                        await this.#executions.cancellation(options.target);
                        return { stopReason: "cancelled" };
                    }
                    throw error;
                } finally {
                    this.#executions.settle(options.target, options.commandId);
                }
            } catch (error) {
                const failedRuntime = this.#executionProcesses.get(options.target);
                if (failedRuntime !== undefined) {
                    await this.#retireSessionProcess(
                        options.target,
                        failedRuntime,
                        async () => await failedRuntime.close(),
                    );
                }
                if (cancelled()) {
                    return { stopReason: "cancelled" };
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent execution failed", {
                    cause: error,
                });
            } finally {
                try {
                    await this.#executions.cancellation(options.target);
                } finally {
                    this.#executions.finish(options.target, options.commandId);
                    this.#executionProcesses.touch(options.target);
                    this.#processes.notifyChanged();
                }
            }
        });

    readonly respondPermission = async (options: PermissionResponseOptions): Promise<void> => {
        this.#admitNow(options.target, { kind: "use" });
        const runtime = this.#executionProcesses.get(options.target);
        if (runtime === undefined) {
            throw new AcpExecutionError("The permission request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondPermission(options);
    };

    readonly respondElicitation = async (options: ElicitationResponseOptions): Promise<void> => {
        this.#admitNow(options.target, { kind: "use" });
        const runtime = this.#executionProcesses.get(options.target);
        if (runtime === undefined) {
            throw new AcpExecutionError("The elicitation request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondElicitation(options);
    };

    /**
     * Removes the Session from the Sessions this Runtime holds: clients are told, its turn stops, and once its process
     * has stopped the Runtime forgets its record and cached events, so it leaves the Session list.
     * The Agent's own history stays; importing the native session holds it again. A Session this Runtime does not hold
     * is already archived.
     */
    readonly archiveSession = async (target: NativeSessionTarget, signal: AbortSignal): Promise<void> =>
        this.#operations.run({ target, signal }, async (options) => await this.#endSession(options));

    async #endSession(options: { readonly target: NativeSessionTarget; readonly signal: AbortSignal }): Promise<void> {
        const settled = Promise.withResolvers<void>();
        const closing = await this.#admit(options.target, { kind: "end" }, options.signal, (): boolean => {
            if (!this.#isKnownSession(options.target)) {
                // A Session this Runtime neither holds nor runs is already archived.
                return false;
            }
            const reason = "This Session was archived.";
            this.#lifecycles.beginClosing(options.target, reason, settled.promise);
            // Announce first: clients must learn of it while its process is still going down. Clients show `reason`
            // to their users as is.
            this.#onSessionClosed({ kind: SESSION_CLOSE_NOTICE_KIND, reason, target: options.target });
            return true;
        });
        if (!closing) {
            return;
        }
        const release = (async (): Promise<void> => {
            try {
                try {
                    const execution = this.#executions.status(options.target);
                    if (execution.kind === "working") {
                        // Closing deliberately stops this turn. Record that intent through the cancellation owner
                        // before releasing the Agent, so its teardown cannot become a retained turn failure.
                        await this.cancelPrompt(options.target, execution.commandId);
                    }
                } finally {
                    // A failed Agent cancellation must still release the closed Session's resources.
                    const retiring = this.#sessionRetirements.get(options.target);
                    if (retiring !== undefined) {
                        await retiring;
                    }
                    const pending = this.#executionProcesses.pending(options.target);
                    const runtime =
                        pending === undefined ? this.#executionProcesses.get(options.target) : await pending;
                    if (runtime !== undefined) {
                        await this.#stopSessionProcess(options.target, runtime);
                    }
                }
            } finally {
                // Clients were told the Session is archived, so whatever failed above, the Runtime forgets it: its
                // record leaves the Session list, and archiving it again finds it already archived. Forgotten before
                // the closing settles, so no operation waiting on it finds the record.
                this.#store.remove(options.target);
            }
        })();
        const deadline = Promise.withResolvers<void>();
        const timeout = this.#timer.schedule(
            () =>
                deadline.reject(
                    new AcpExecutionError(
                        "The Session could not close before its deadline",
                        {},
                        "session_close_timeout",
                    ),
                ),
            SESSION_CLOSE_TIMEOUT_MILLISECONDS,
        );
        void Promise.race([release, deadline.promise]).finally(timeout.cancel).then(settled.resolve, settled.reject);
        // A closing that missed its deadline stays closing until its process is actually released.
        const releaseFinished = (): void => this.#lifecycles.endClosing(options.target, settled.promise);
        void release.then(releaseFinished, releaseFinished);
        await waitForSharedOperation(settled.promise, options.signal);
    }

    readonly close = async (): Promise<void> => {
        const retiring = this.#processes.stopIdleReclamation();
        await this.#operations.close(async () => {
            await retiring;
            const sessions = [...this.#executionProcesses.entries()];
            await Promise.all([
                ...sessions.map(
                    async ([target, runtime]) =>
                        await this.#retireSessionProcess(target, runtime, async () => await runtime.close()),
                ),
                ...this.#lifecycles.closings(),
            ]);
        });
    };

    readonly findSessions = (targets: readonly NativeSessionTarget[]) =>
        targets.flatMap((target) => {
            const stored = this.#store.read(target);
            return stored !== undefined ? [stored] : [];
        });

    /** The Session this Runtime holds for `target`, which a command naming only the target uses; none is refused. */
    readonly heldSession = (target: NativeSessionTarget): StoredSession => {
        const stored = this.#store.read(target);
        if (stored === undefined) {
            throw new AcpExecutionError("The Session was not found", {}, "session_not_found");
        }
        return stored;
    };

    readonly sessionStatus = (target: NativeSessionTarget): SessionStatus =>
        this.#reported(target, this.#executions.status(target));

    /** An idle Session whose last started command failed says so, so a client that did not watch it still knows. */
    readonly #reported = (target: NativeSessionTarget, status: SessionStatus): SessionStatus => {
        if (status.kind !== "idle") {
            return status;
        }
        const lastTurn = this.#lastTurn(target);
        return lastTurn?.state === "failed"
            ? {
                  ...status,
                  failedTurn: { code: lastTurn.code, commandId: lastTurn.commandId, message: lastTurn.message },
              }
            : status;
    };

    /**
     * The Sessions this Runtime holds, most recently updated first: Morty's directory of Sessions on this computer. A
     * Session not yet prompted is listed too, so a conversation whose first prompt has not arrived is not lost.
     */
    readonly listSessions = (limit: number) => this.#store.list().slice(0, limit);

    /** The actionable requests of the Session this Runtime holds for `target`; a target it does not hold is refused. */
    readonly interactionSnapshot = (target: NativeSessionTarget): SessionInteractionSnapshot => {
        const session = this.heldSession(target);
        const runtime = this.#executionProcesses.get(session.target);
        if (runtime !== undefined) {
            return runtime.interactionSnapshot();
        }
        // No live Agent owns an actionable request after its session process has gone away.
        const { sessionGenerationId, throughPosition } = this.#store.events.livePosition(session.target);
        return { sessionGenerationId, throughPosition, interactions: [] };
    };

    readonly createNativeSession = async (options: SessionCreationOptions): Promise<NativeSessionTarget> =>
        this.#operations.run(options, async (options) => {
            const runtime = await this.#processes.startUnretained(
                options.signal,
                async () =>
                    await AgentSession.create(
                        options,
                        this.#observer,
                        this.#executionRecord,
                        this.#store,
                        unmeasuredOperationMetrics,
                    ),
            );
            let retained = false;
            try {
                const target = runtime.target;
                if (!isIdentifier(target.sessionId) || this.#executionProcesses.get(target) !== undefined) {
                    throw new AcpExecutionError(
                        "The Agent returned an invalid new Session ID",
                        {},
                        "invalid_native_session_response",
                    );
                }
                this.#executionProcesses.retain(target, runtime);
                this.#processes.retain(runtime, this.#retention(target));
                retained = true;
                return target;
            } finally {
                if (!retained) {
                    await this.#processes.retire(runtime, () => runtime.closeProcess());
                }
            }
        });

    readonly ensureSession = async (options: SessionPrepareOptions): Promise<AgentSession> =>
        this.#operations.run(options, async (options) => {
            this.#admitNow(options.target, { kind: "use" });
            const existing = this.#executionProcesses.get(options.target);
            if (existing !== undefined) {
                if (!existing.runsIn(options.cwd)) {
                    throw new AcpExecutionError(
                        "The workspace cannot change after a conversation has started",
                        {},
                        "session_identity_mismatch",
                    );
                }
                const runtime = await this.#currentSessionProcess(
                    existing,
                    options,
                    options.recovery ?? { kind: "interactive-only" },
                );
                this.#executionProcesses.touch(options.target, runtime);
                return runtime;
            }
            await this.#prepareSession(options, options.recovery ?? { kind: "interactive-only" });
            const started = this.#executionProcesses.get(options.target);
            if (started === undefined) {
                throw new AcpExecutionError("ACP session did not start");
            }
            return started;
        });

    /** Coordinates native-reader conflicts without owning the harness query. */
    readonly withNativeSessionOperation = async <Result>(
        options: SessionCreationOptions,
        sessionId: string,
        operation: (options: SessionCreationOptions) => Promise<Result>,
    ): Promise<Result> =>
        this.#operations.run(options, async (options) => {
            const target = { harness: options.agent.harness, sessionId };
            this.#admitNow(target, { kind: "native-exclusive" });
            this.#lifecycles.beginNativeOperation(target);
            this.#processes.notifyChanged();
            try {
                return await operation(options);
            } finally {
                this.#lifecycles.endNativeOperation(target);
                this.#processes.notifyChanged();
            }
        });

    readonly loadSessionEvents = async (
        options: SessionPrepareOptions,
        eventLimit: number,
        cursor: string | null,
    ): Promise<SessionEventPage> =>
        this.#operations.run(options, async (options) => {
            return await this.#executionProcesses.use(options.target, async () => {
                const runtime = await this.ensureSession(options);
                return await runtime.loadHistoryEvents(eventLimit, cursor, options.signal);
            });
        });

    async #nativeTargetOptions(
        options: SessionCreationOptions,
        target: NativeSessionTarget,
        resolveAgent: ResolveAgent,
    ): Promise<SessionPrepareOptions> {
        const resolved = await resolveAgent(options.agent.harness, options.signal);
        options.signal.throwIfAborted();
        return { ...options, ...resolved, target };
    }

    readonly openNativeSession = async (
        options: SessionCreationOptions,
        origin: NativeSessionOrigin,
        resolveAgent: ResolveAgent,
    ): Promise<{
        readonly target: NativeSessionTarget;
        readonly prepared: PreparedSession;
    }> =>
        this.#operations.run(options, async (options) => {
            const source = { harness: options.agent.harness, sessionId: origin.sessionId };
            if (origin.kind === "import") {
                // Importing opens the Session again, even when it was closed or archived.
                await this.#admit(source, { kind: "import" }, options.signal, () => undefined);
            }
            // These checks and the start of the native operation below are synchronous.
            this.#admitNow(source, { kind: "native-exclusive" });
            const held = this.#isHeld(source);
            if (origin.kind === "import" && held) {
                return await this.#executionProcesses.use(source, async () => {
                    // A running turn does not prevent importing a Session the Runtime already tracks: another device
                    // joins the same Session and sees the turn's progress.
                    const target = await this.#nativeTargetOptions(options, source, resolveAgent);
                    const runtime = await this.ensureSession(target);
                    // A fork or history read may have begun while the Session was readied.
                    this.#admitNow(source, { kind: "native-exclusive" });
                    return { prepared: runtime.prepared(), target: source };
                });
            }
            // A fork or a first import reads the native session, which a running turn may still be writing.
            if (held && (this.#executions.isBusy(source) || this.#executionProcesses.pending(source) !== undefined)) {
                throw new AcpExecutionError(
                    "Wait for the native session's running operation to finish",
                    {},
                    "session_busy",
                );
            }
            this.#lifecycles.beginNativeOperation(source);
            try {
                if (origin.kind === "import") {
                    const preparation = await this.#nativeTargetOptions(options, source, resolveAgent);
                    const runtime = await this.#startPreparation(
                        { ...preparation, origin },
                        { kind: "interactive-only" },
                    );
                    return { target: source, prepared: runtime.prepared() };
                }
                const capabilities = await options.adapter.getCapabilities(nativeSessionQuery(options));
                const runtime = await this.#processes.startUnretained(
                    options.signal,
                    async () =>
                        await AgentSession.fork(
                            options,
                            origin,
                            capabilities,
                            this.#observer,
                            this.#executionRecord,
                            this.#store,
                            unmeasuredOperationMetrics,
                        ),
                );
                let retained = false;
                try {
                    const target = runtime.target;
                    if (this.#executionProcesses.get(target) !== undefined) {
                        throw new AcpExecutionError(
                            "The harness returned an existing fork",
                            {},
                            "invalid_native_session_response",
                        );
                    }
                    this.#executionProcesses.retain(target, runtime);
                    this.#processes.retain(runtime, this.#retention(target));
                    retained = true;
                    return { target, prepared: runtime.prepared() };
                } finally {
                    if (!retained) {
                        await this.#processes.retire(runtime, () => runtime.closeProcess());
                    }
                }
            } finally {
                this.#lifecycles.endNativeOperation(source);
                this.#processes.notifyChanged();
            }
        });
}
