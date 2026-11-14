import type { SessionCapabilities } from "@morty-build/client/protocol";
import { type NativeSessionQueryKey, nativeSessionQueryKey } from "../../../src/engine/acp/adapter/query-scope.ts";
import type { AcpAgentDefinition } from "../../../src/engine/acp/agent/agent-definition.ts";
import type { NativeSessionQuery } from "../../../src/engine/acp/native-history/preview-contract.ts";
import type { NativeSessionPage } from "../../../src/engine/acp/protocol/native-session.ts";
import type { AgentProcessPool } from "../../../src/engine/session/process/agent-process-pool.ts";
import { RetainedAgentProcesses } from "../../../src/engine/session/process/retained-agent-processes.ts";
import { waitForSharedOperation } from "../../../src/engine/util/wait-for-shared-operation.ts";
import { AcpQuerySession } from "./query-session.ts";
import type { AcpSessionConnector } from "./session-events.ts";

/** Owns workspace-scoped readers, independently of execution conversations. */
export class AgentQueryProcesses {
    readonly #processesByAgent = new Map<
        AcpAgentDefinition,
        RetainedAgentProcesses<AcpQuerySession, NativeSessionQueryKey>
    >();
    #agent: AcpAgentDefinition;
    readonly #processes: AgentProcessPool;
    readonly #connector: AcpSessionConnector;

    constructor(agent: AcpAgentDefinition, processes: AgentProcessPool, connector: AcpSessionConnector) {
        this.#agent = agent;
        this.#processes = processes;
        this.#connector = connector;
    }

    readonly refreshAgent = (agent: AcpAgentDefinition): void => {
        this.#agent = agent;
    };

    readonly retire = async (
        readers: RetainedAgentProcesses<AcpQuerySession, NativeSessionQueryKey>,
        key: NativeSessionQueryKey,
        runtime: AcpQuerySession,
    ): Promise<void> => {
        readers.detach(key, runtime);
        await this.#processes.retire(runtime, () => runtime.closeProcess());
    };

    async #ensure(
        readers: RetainedAgentProcesses<AcpQuerySession, NativeSessionQueryKey>,
        query: NativeSessionQuery,
    ): Promise<AcpQuerySession> {
        query.signal.throwIfAborted();
        const key = nativeSessionQueryKey(query);
        const pending = readers.pending(key);
        if (pending !== undefined) {
            return await waitForSharedOperation(pending, query.signal);
        }
        const existing = readers.get(key);
        if (existing !== undefined && !existing.hasTerminated()) {
            readers.touch(key, existing);
            return existing;
        }
        return await readers.prepare(key, async () => {
            if (existing !== undefined) {
                await this.retire(readers, key, existing);
            }
            const runtime = await this.#processes.startRetained(
                query.signal,
                () => AcpQuerySession.start(query, this.#connector),
                {
                    isBusy: () => readers.isBusy(key),
                    retire: (runtime) => this.retire(readers, key, runtime),
                    retireIdle: (runtime) => this.retire(readers, key, runtime),
                },
            );
            readers.retain(key, runtime);
            return runtime;
        });
    }

    readonly #use = async <T>(
        query: NativeSessionQuery,
        operation: (runtime: AcpQuerySession) => Promise<T>,
    ): Promise<T> => {
        // Capture one immutable catalog definition while waiting for capacity.
        const agent = this.#agent;
        const scoped = { ...query, agent };
        let readers = this.#processesByAgent.get(agent);
        if (readers === undefined) {
            readers = new RetainedAgentProcesses<AcpQuerySession, NativeSessionQueryKey>(
                {
                    touch: this.#processes.touch,
                    changed: this.#processes.notifyChanged,
                },
                (key) => key,
            );
            this.#processesByAgent.set(agent, readers);
        }
        const current = readers;
        return await current.use(
            nativeSessionQueryKey(scoped),
            async () => await operation(await this.#ensure(current, scoped)),
        );
    };

    readonly capabilities = async (query: NativeSessionQuery): Promise<SessionCapabilities> =>
        await this.#use(query, async (runtime) => runtime.capabilities());

    readonly listNativeSessions = async (
        query: NativeSessionQuery,
        cursor: string | null,
    ): Promise<NativeSessionPage> =>
        await this.#use(query, async (runtime) => await runtime.listNativeSessions(cursor, query.signal));

    readonly close = async (): Promise<void> => {
        await Promise.all(
            [...this.#processesByAgent.values()].flatMap((readers) =>
                readers.entries().map(async ([key, runtime]) => await this.retire(readers, key, runtime)),
            ),
        );
        this.#processesByAgent.clear();
    };
}
