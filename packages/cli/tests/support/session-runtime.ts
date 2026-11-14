import { AdapterRegistry } from "../../src/engine/acp/adapter/adapter-registry.ts";
import type { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import type { AdapterResolver } from "../../src/engine/acp/native-history/preview-contract.ts";
import type { OperationMetrics } from "../../src/engine/infra/operation-metrics.ts";
import type {
    AgentSettingsInspectionOptions,
    SessionConfigurationChange,
    SessionConfigureOptions,
    SessionCreationOptions,
    SessionPrepareOptions,
    SessionSteerOptions,
    SessionTurnOptions,
} from "../../src/engine/session/api/session-api.ts";
import { SessionManager } from "../../src/engine/session/manager/session-manager.ts";
import { nativeSessionQuery } from "../../src/engine/session/native/native-query.ts";
import { AgentProcessPool } from "../../src/engine/session/process/agent-process-pool.ts";

export type TestSessionPrepareOptions = Omit<SessionPrepareOptions, "adapter">;

/** Composes real session resources for direct session scenarios, with Computer owning the adapters. */
/** `Omit` that keeps each variant of a union apart. */
type WithoutAdapter<Options> = Options extends unknown ? Omit<Options, "adapter"> : never;

export class SessionRuntimeFixture {
    readonly sessions: SessionManager;
    readonly adapters: AdapterRegistry;

    constructor(
        options: Omit<ConstructorParameters<typeof SessionManager>[0], "processes"> & {
            readonly adapters: AdapterResolver;
            readonly contentExternalizer: AcpContentExternalizer;
            readonly maxProcesses: number | null;
        },
    ) {
        const processes = new AgentProcessPool(options.maxProcesses ?? undefined, options.timer);
        this.adapters = new AdapterRegistry(options.adapters, {
            processes,
            contentExternalizer: options.contentExternalizer,
        });
        this.sessions = new SessionManager({ ...options, processes });
    }

    readonly resolveAgent = async (agent: SessionPrepareOptions["agent"]) => ({
        agent,
        adapter: this.adapters.resolve(agent),
    });

    readonly prepareSession = (options: TestSessionPrepareOptions, metrics?: OperationMetrics) =>
        this.sessions.prepareSession({ ...options, adapter: this.adapters.resolve(options.agent) }, metrics);

    readonly restoreSession = (options: TestSessionPrepareOptions, metrics?: OperationMetrics) =>
        this.sessions.restoreSession({ ...options, adapter: this.adapters.resolve(options.agent) }, metrics);

    readonly prepareExecutionSession = (options: TestSessionPrepareOptions) =>
        this.sessions.prepareExecutionSession({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly ensureSession = (options: TestSessionPrepareOptions) =>
        this.sessions.ensureSession({ ...options, adapter: this.adapters.resolve(options.agent) });

    /** A Session created with the Agent's own settings. */
    readonly createNativeSession = async (options: Omit<SessionCreationOptions, "adapter">) =>
        (
            await this.sessions.createSession(
                { ...options, adapter: this.adapters.resolve(options.agent) },
                async () => undefined,
            )
        ).target;

    readonly createConfiguredSession = (
        options: Omit<SessionCreationOptions, "adapter">,
        configure: Parameters<SessionManager["createSession"]>[1],
    ) => this.sessions.createSession({ ...options, adapter: this.adapters.resolve(options.agent) }, configure);

    readonly createSession = async (
        options: Omit<SessionCreationOptions, "adapter">,
    ): Promise<TestSessionPrepareOptions> => ({
        ...options,
        target: await this.createNativeSession(options),
    });

    readonly inspectAgentSettings = (options: Omit<AgentSettingsInspectionOptions, "adapter">) =>
        this.sessions.inspectAgentSettings({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly configureSession = (options: WithoutAdapter<SessionConfigureOptions>) =>
        this.sessions.configureSession({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly applySessionConfiguration = (options: WithoutAdapter<SessionConfigurationChange>) =>
        this.sessions.applySessionConfiguration({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly runPrompt = (options: Omit<SessionTurnOptions, "adapter">) =>
        this.sessions.runPrompt({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly steerPrompt = (options: Omit<SessionSteerOptions, "adapter">) =>
        this.sessions.steerPrompt({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly nativeSessionCapabilities = (options: Omit<SessionCreationOptions, "adapter">) =>
        this.adapters
            .resolve(options.agent)
            .getCapabilities(nativeSessionQuery({ ...options, adapter: this.adapters.resolve(options.agent) }));

    readonly listNativeSessions = (options: Omit<SessionCreationOptions, "adapter">, cursor: string | null) =>
        this.adapters.resolve(options.agent).listSessions({
            query: nativeSessionQuery({ ...options, adapter: this.adapters.resolve(options.agent) }),
            cursor,
        });

    readonly previewNativeSessionEvents = (
        options: Omit<SessionCreationOptions, "adapter">,
        sessionId: string,
        eventLimit: number,
        cursor: string | null,
    ) =>
        this.sessions.withNativeSessionOperation(
            { ...options, adapter: this.adapters.resolve(options.agent) },
            sessionId,
            (target) =>
                target.adapter.readSessionHistory({
                    query: nativeSessionQuery(target),
                    request: {
                        sessionId,
                        eventLimit,
                        cursor,
                    },
                }),
        );

    readonly loadSessionEvents = (options: TestSessionPrepareOptions, eventLimit: number, cursor: string | null) =>
        this.sessions.loadSessionEvents(
            { ...options, adapter: this.adapters.resolve(options.agent) },
            eventLimit,
            cursor,
        );

    readonly openNativeSession = (
        options: Omit<SessionCreationOptions, "adapter">,
        origin: Parameters<SessionManager["openNativeSession"]>[1],
    ) =>
        this.sessions.openNativeSession(
            { ...options, adapter: this.adapters.resolve(options.agent) },
            origin,
            async () => ({ agent: options.agent, adapter: this.adapters.resolve(options.agent) }),
        );

    readonly close = async (): Promise<void> => {
        try {
            await this.sessions.close();
        } finally {
            await this.adapters.close();
        }
    };

    readonly recordLifecycleEvent = (...args: Parameters<SessionManager["recordLifecycleEvent"]>) =>
        this.sessions.recordLifecycleEvent(...args);
    readonly renameSession = (...args: Parameters<SessionManager["renameSession"]>) =>
        this.sessions.renameSession(...args);
    readonly cancelPrompt = (...args: Parameters<SessionManager["cancelPrompt"]>) =>
        this.sessions.cancelPrompt(...args);
    readonly respondPermission = (...args: Parameters<SessionManager["respondPermission"]>) =>
        this.sessions.respondPermission(...args);
    readonly respondElicitation = (...args: Parameters<SessionManager["respondElicitation"]>) =>
        this.sessions.respondElicitation(...args);
    readonly archiveSession = (...args: Parameters<SessionManager["archiveSession"]>) =>
        this.sessions.archiveSession(...args);
    readonly findSessions = (...args: Parameters<SessionManager["findSessions"]>) =>
        this.sessions.findSessions(...args);
    readonly sessionStatus = (...args: Parameters<SessionManager["sessionStatus"]>) =>
        this.sessions.sessionStatus(...args);
    readonly listSessions = (...args: Parameters<SessionManager["listSessions"]>) =>
        this.sessions.listSessions(...args);
}
