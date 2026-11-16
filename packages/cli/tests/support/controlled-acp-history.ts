import { methods } from "@agentclientprotocol/sdk/unstable";
import { AcpExecutionError } from "../../src/engine/acp/acp-error.ts";
import {
    RetryableAcpInitializationError,
    validateAgentRuntime,
} from "../../src/engine/acp/adapter/agent-initialization.ts";
import { nativeSessionPreviewKey, nativeSessionQueryKey } from "../../src/engine/acp/adapter/query-scope.ts";
import type { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import type {
    NativeSessionPreviewRequest,
    NativeSessionQuery,
    SessionEventPage,
} from "../../src/engine/acp/native-history/preview-contract.ts";
import {
    memoryHistoryPreviewSnapshot,
    NativeHistoryPreviewSnapshots,
} from "../../src/engine/acp/native-history/preview-snapshots.ts";
import type { SessionEventStore } from "../../src/engine/session/history/session-event-store.ts";
import type { AgentProcessPool } from "../../src/engine/session/process/agent-process-pool.ts";
import type { AcpSessionConnector, AdapterSessionConnection } from "./acp/session-events.ts";

export class ControlledAcpHistory {
    readonly #snapshots = new NativeHistoryPreviewSnapshots(memoryHistoryPreviewSnapshot, Infinity);
    readonly #processes: AgentProcessPool;
    readonly #connector: AcpSessionConnector;
    #agent: AcpAgentDefinition;

    constructor(agent: AcpAgentDefinition, processes: AgentProcessPool, connector: AcpSessionConnector) {
        this.#agent = agent;
        this.#processes = processes;
        this.#connector = connector;
    }

    readonly refreshAgent = (agent: AcpAgentDefinition): void => {
        this.#agent = agent;
    };

    async #start(
        query: NativeSessionQuery,
        sessionId: string,
        store: SessionEventStore,
    ): Promise<AdapterSessionConnection> {
        const { agent, signal } = query;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await validateAgentRuntime(agent, signal);
            const connection = this.#connector.connectQuerySession({
                agent,
                cwd: query.cwd,
                ...(query.externalizeUpdate === undefined ? {} : { externalizeUpdate: query.externalizeUpdate }),
                onEvent: async (event) => {
                    store.append({ harness: agent.harness, sessionId }, { type: "acp", payload: event.payload });
                },
            });
            try {
                await connection.initializeAgent(signal);
                return connection;
            } catch (error) {
                await connection.closeProcess();
                signal.throwIfAborted();
                if (error instanceof RetryableAcpInitializationError && attempt === 1) {
                    continue;
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent initialization failed", { cause: error });
            }
        }
        throw new AcpExecutionError("ACP agent initialization failed");
    }

    readonly read = async (
        query: NativeSessionQuery,
        request: NativeSessionPreviewRequest,
    ): Promise<SessionEventPage> => {
        query.signal.throwIfAborted();
        const scoped = { ...query, agent: this.#agent };
        const { sessionId, eventLimit, cursor } = request;
        const target = { harness: scoped.agent.harness, sessionId };
        const key = nativeSessionPreviewKey(nativeSessionQueryKey(scoped), sessionId);
        if (cursor !== null) {
            return this.#snapshots.get(key).page(target, eventLimit, cursor);
        }
        const snapshot = this.#snapshots.create();
        const store = snapshot.events;
        try {
            const page = await this.#processes.runTransient(
                query.signal,
                () => this.#start(scoped, sessionId, store),
                async (connection) => {
                    if (!connection.snapshot().capabilities.loadSession) {
                        throw new AcpExecutionError(
                            "This Agent restores context but does not provide message history.",
                            {},
                            "native_history_unsupported",
                        );
                    }
                    connection.events.select(sessionId);
                    connection.beginStateChange();
                    const response: unknown = await connection.race(
                        connection.connection.agent.request(
                            methods.agent.session.load,
                            { cwd: scoped.cwd, mcpServers: [], sessionId },
                            { cancellationSignal: query.signal },
                        ),
                        "ACP agent exited while loading history",
                        query.signal,
                    );
                    await connection.events.drained();
                    query.signal.throwIfAborted();
                    connection.commitLifecycle(response);
                    return store.page(target, eventLimit, null);
                },
                (connection) => connection.closeProcess(),
            );
            query.signal.throwIfAborted();
            this.#snapshots.retain(key, snapshot);
            return page;
        } catch (error) {
            snapshot.close();
            throw error;
        }
    };

    readonly close = (): void => this.#snapshots.close();
}
