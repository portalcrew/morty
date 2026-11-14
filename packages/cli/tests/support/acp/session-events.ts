import { setImmediate as yieldToRuntime } from "node:timers/promises";
import type { SessionCapabilities, SessionConfigOption } from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../../src/engine/acp/acp-error.ts";
import {
    type NativeSessionEvent,
    type NativeSessionInteractions,
    nativeSessionEvent,
} from "../../../src/engine/acp/adapter/native-session-event.ts";
import type { AcpAgentDefinition } from "../../../src/engine/acp/agent/agent-definition.ts";
import type { BackgroundActivity, PromptDelegationStage } from "../../../src/engine/acp/agent/agent-lifecycle.ts";
import type { IdentifiedSessionNotification as SessionNotification } from "../../../src/engine/acp/connection/session-notification.ts";
import type {
    AcpContentExternalizer,
    ExternalizeSessionUpdate,
} from "../../../src/engine/acp/content/content-externalizer.ts";
import { restrictAcpSessionCapabilities } from "../../../src/engine/acp/protocol/session-capabilities.ts";
import {
    normalizeSessionConfiguration,
    normalizeSessionConfigurationUpdate,
} from "../../../src/engine/acp/protocol/session-configuration.ts";
import type { AgentConnection } from "../agents/agent-connection.ts";
import { connectControlledAgent } from "../agents/controlled-agent-definition.ts";
import {
    applyConfigurationChanges,
    applyConfigurationMode,
    type ConfigurationChanges,
    recordConfigurationMode,
    recordConfigurationOptions,
} from "./configuration-changes.ts";
import { ControlledSessionUpdates } from "./controlled-session-updates.ts";
import type { AcpClientHandler } from "./create-client.ts";
import { initializeAgentConnection } from "./initialize-controlled-agent.ts";

interface SessionConnectionScope {
    readonly agent: AcpAgentDefinition;
    readonly cwd: string;
    readonly externalizeUpdate?: ExternalizeSessionUpdate;
    readonly onEvent: (event: NativeSessionEvent) => Promise<void>;
}

export interface AdapterSessionConnectionOptions extends SessionConnectionScope {
    readonly onBackgroundActivity?: (activity: BackgroundActivity) => void;
    readonly onPromptDelegation?: (stage: PromptDelegationStage) => Promise<void>;
    readonly interactions: NativeSessionInteractions;
}

export interface AdapterSessionSnapshot {
    readonly capabilities: SessionCapabilities;
    readonly configOptions: readonly SessionConfigOption[];
}

type ConfigurationOperation =
    | { readonly kind: "idle" }
    | { readonly kind: "pending"; readonly changes: ConfigurationChanges };
type ExecutionState =
    | { readonly kind: "uninitialized" }
    | {
          readonly kind: "ready";
          readonly snapshot: AdapterSessionSnapshot;
          readonly operation: ConfigurationOperation;
      }
    | { readonly kind: "closed" };

/** ACP subscription lifetime, ordered delivery and harness normalization belong to the adapter. */
export class AdapterSessionConnection {
    readonly #connection: AgentConnection;
    readonly #onBackgroundActivity: (activity: BackgroundActivity) => void;
    readonly #updates: ControlledSessionUpdates;
    readonly #lifetime = new AbortController();
    readonly #onClosed: () => void;
    readonly #agent: AcpAgentDefinition;
    #state: ExecutionState = { kind: "uninitialized" };
    #initialization:
        | { readonly kind: "not-started" }
        | { readonly kind: "started"; readonly result: ReturnType<typeof initializeAgentConnection> } = {
        kind: "not-started",
    };
    readonly events: Pick<ControlledSessionUpdates, "sessionId" | "select" | "drained">;

    constructor(
        options: AdapterSessionConnectionOptions,
        externalizer: Pick<AcpContentExternalizer, "update">,
        onClosed: () => void = () => undefined,
    ) {
        this.#agent = options.agent;
        this.#onClosed = onClosed;
        this.#onBackgroundActivity = options.onBackgroundActivity ?? (() => {});
        this.#updates = new ControlledSessionUpdates(async (notification: SessionNotification) => {
            this.#lifetime.signal.throwIfAborted();
            if (notification.sessionId !== this.#updates.sessionId()) {
                throw new AcpExecutionError("ACP agent referenced an unknown session", {}, "invalid_agent_session");
            }
            const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(30_000)]);
            const externalized =
                options.externalizeUpdate === undefined
                    ? await externalizer.update(
                          { harness: options.agent.harness, sessionId: notification.sessionId },
                          notification.update,
                          signal,
                      )
                    : await options.externalizeUpdate(notification.sessionId, notification.update, signal);
            signal.throwIfAborted();
            const update = externalized.agent;
            for (const eventUpdate of externalized.events) {
                let event = nativeSessionEvent(update, eventUpdate);
                if (update.sessionUpdate === "config_option_update") {
                    this.#applyConfigurationUpdate(update.configOptions);
                    event = {
                        kind: "configuration",
                        payload: event.payload,
                        configOptions: this.snapshot().configOptions,
                    };
                } else if (update.sessionUpdate === "current_mode_update") {
                    this.#applyModeUpdate(update.currentModeId);
                }
                await options.onEvent(event);
            }
        });
        this.events = this.#updates;
        const client: AcpClientHandler = {
            onUpdate: async (notification) => {
                if (this.#lifetime.signal.aborted) {
                    return;
                }
                try {
                    await this.#updates.receive(notification);
                } catch (error) {
                    // Closing this subscription cancels delivery, not the harness's
                    // background notification producer. Observe our own cancellation
                    // here; operational failures still reach the caller and drain.
                    if (this.#lifetime.signal.aborted && error === this.#lifetime.signal.reason) {
                        return;
                    }
                    throw error;
                }
            },
            onPermission: async (request, signal) => {
                // ACP dispatches requests concurrently. Apply preceding tool updates before describing the permission.
                await yieldToRuntime(undefined, { signal });
                await this.#updates.drained();
                signal.throwIfAborted();
                return await options.interactions.onPermission(request, signal);
            },
            onElicitation: options.interactions.onElicitation,
            onElicitationComplete: options.interactions.onElicitationComplete,
        };
        this.#connection = connectControlledAgent(options.agent, {
            cwd: options.cwd,
            client,
            onPromptDelegation: async (stage) => {
                if (!this.#lifetime.signal.aborted) {
                    await options.onPromptDelegation?.(stage);
                }
            },
        });
    }

    get connection() {
        return this.#connection.connection;
    }
    get termination() {
        return this.#connection.termination;
    }

    readonly #ready = (): Extract<ExecutionState, { readonly kind: "ready" }> => {
        const state = this.#state;
        if (state.kind !== "ready") {
            throw new AcpExecutionError(
                "The Agent session is not initialized or has closed",
                {},
                "invalid_agent_session",
            );
        }
        return state;
    };

    readonly snapshot = (): AdapterSessionSnapshot => this.#ready().snapshot;

    readonly beginStateChange = (): void => {
        const state = this.#ready();
        if (state.operation.kind !== "idle") {
            throw new AcpExecutionError("Another session configuration operation is running", {}, "session_busy");
        }
        this.#state = { ...state, operation: { kind: "pending", changes: { kind: "unchanged" } } };
    };

    readonly cancelStateChange = (): void => {
        if (this.#state.kind === "ready") {
            this.#state = { ...this.#state, operation: { kind: "idle" } };
        }
    };

    readonly commitConfiguration = (options: readonly SessionConfigOption[]): readonly SessionConfigOption[] => {
        const state = this.#ready();
        if (state.operation.kind !== "pending") {
            throw new AcpExecutionError("No session configuration operation is running", {}, "invalid_agent_session");
        }
        const configOptions = applyConfigurationChanges(options, state.operation.changes);
        this.#state = { ...state, snapshot: { ...state.snapshot, configOptions }, operation: { kind: "idle" } };
        return configOptions;
    };

    readonly commitLifecycle = (response: unknown): AdapterSessionSnapshot => {
        const state = this.#ready();
        const capabilities = restrictAcpSessionCapabilities(state.snapshot.capabilities, response);
        this.commitConfiguration(normalizeSessionConfiguration(response));
        this.#state = { ...this.#ready(), snapshot: { capabilities, configOptions: this.snapshot().configOptions } };
        return this.snapshot();
    };

    readonly #applyConfigurationUpdate = (value: unknown): void => {
        const state = this.#ready();
        const configOptions = normalizeSessionConfigurationUpdate(state.snapshot.configOptions, value);
        const operation: ConfigurationOperation =
            state.operation.kind === "pending"
                ? {
                      kind: "pending",
                      changes: recordConfigurationOptions(
                          state.operation.changes,
                          normalizeSessionConfigurationUpdate([], value),
                      ),
                  }
                : state.operation;
        this.#state = { ...state, snapshot: { ...state.snapshot, configOptions }, operation };
    };

    readonly #applyModeUpdate = (modeId: string): void => {
        const state = this.#ready();
        const operation: ConfigurationOperation =
            state.operation.kind === "pending"
                ? { kind: "pending", changes: recordConfigurationMode(state.operation.changes, modeId) }
                : state.operation;
        this.#state = {
            ...state,
            snapshot: {
                ...state.snapshot,
                configOptions: applyConfigurationMode(state.snapshot.configOptions, modeId),
            },
            operation,
        };
    };
    readonly initialize = (signal: AbortSignal): Promise<void> => this.#connection.initialize(signal);
    readonly initializeAgent = (signal: AbortSignal) => {
        if (this.#initialization.kind === "not-started") {
            this.#initialization = {
                kind: "started",
                result: initializeAgentConnection(this, this.#agent.harness, this.#agent.agentVersion, signal).then(
                    (agent) => {
                        this.#lifetime.signal.throwIfAborted();
                        this.#state = {
                            kind: "ready",
                            snapshot: { capabilities: agent.capabilities, configOptions: [] },
                            operation: { kind: "idle" },
                        };
                        return agent;
                    },
                ),
            };
        }
        return this.#initialization.result;
    };
    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        this.#connection.race(operation, exitMessage, signal);

    readonly closeProcess = async (): Promise<void> => {
        this.#state = { kind: "closed" };
        this.#lifetime.abort(new DOMException("The adapter event subscription closed", "AbortError"));
        try {
            await this.#connection.closeProcess();
        } finally {
            // Every queued delivery is observed before releasing this subscription.
            try {
                await this.#updates.drained().catch(() => undefined);
            } finally {
                this.#onClosed();
                this.#onBackgroundActivity("none");
            }
        }
    };
}

/** Query connections for the stateful controlled ACP peer. */
export class AcpSessionConnector {
    readonly #externalizer: Pick<AcpContentExternalizer, "update">;
    constructor(externalizer: Pick<AcpContentExternalizer, "update">) {
        this.#externalizer = externalizer;
    }
    readonly connectQuerySession = (options: SessionConnectionScope): AdapterSessionConnection => {
        const rejectInteraction = async (): Promise<never> => {
            throw new AcpExecutionError(
                "Read-only history previews cannot request user interaction",
                {},
                "native_session_interaction_unsupported",
            );
        };
        return new AdapterSessionConnection(
            {
                ...options,
                interactions: {
                    onPermission: rejectInteraction,
                    onElicitation: rejectInteraction,
                    onElicitationComplete: rejectInteraction,
                },
            },
            this.#externalizer,
        );
    };
}
