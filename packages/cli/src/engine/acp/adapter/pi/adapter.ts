import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import { decodeAgentPromptResponse, type SessionConfigOption } from "@morty-build/client/protocol";
import { runCleanup } from "../../../util/run-cleanup.ts";
import { truncate } from "../../../util/value-utils.ts";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp-error.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { buildPromptContent } from "../../client/prompt-content.ts";
import { agentOperationError, waitForAgentOperation } from "../../connection/agent-operation.ts";
import type { PiAcpAgent } from "../../harness/pi/upstream/dist/acp/agent.js";
import type {
    Adapter,
    AdapterDependencies,
    AdapterSessionCreateParams,
    AdapterSessionOpened,
    AdapterSessionOpenParams,
    AdapterSessionTarget,
} from "../../native-history/preview-contract.ts";
import { memoryHistoryPreviewSnapshot } from "../../native-history/preview-snapshots.ts";
import { nativeSessionPageSchema, type SessionId, sessionIdSchema } from "../../protocol/native-session.ts";
import { normalizeAcpCapabilities } from "../../protocol/session-capabilities.ts";
import { normalizeSessionConfiguration } from "../../protocol/session-configuration.ts";
import { HarnessHistoryPreviews } from "../harness-history-previews.ts";
import type { HarnessSession } from "../harness-session.ts";
import { sessionCreationResponse } from "../lifecycle-output.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { piClientCallbacks, piSessionCallbacks } from "./client-callbacks.ts";
import { createPiCatalogClient, createPiClient, type PiClientRuntime, piRuntime } from "./create-client.ts";
import { type PiWorkspace, startPiSession } from "./pi-session.ts";

const START_TIMEOUT_MILLISECONDS = 60_000;

/** The fields of Pi's new/fork/resume/load responses that describe the opened session. */
interface PiSessionResponse {
    readonly configOptions?: unknown;
    readonly modes?: unknown;
}

function workspaceOf(target: { readonly cwd: string }): PiWorkspace {
    return { cwd: target.cwd };
}

/** Live Pi operations call the Pi harness directly; each native session owns one Pi client. */
export class PiAdapter implements Adapter {
    readonly #dependencies: AdapterDependencies;
    readonly #sessions = new Map<SessionId, HarnessSession<PiAcpAgent>>();
    readonly #lifetime = new AbortController();
    readonly #previews: HarnessHistoryPreviews;
    #agent: AcpAgentDefinition;
    #runtime: PiClientRuntime;

    constructor(agent: AcpAgentDefinition, dependencies: AdapterDependencies) {
        this.#agent = agent;
        this.#runtime = piRuntime(agent);
        this.#dependencies = dependencies;
        this.#previews = new HarnessHistoryPreviews(dependencies.processes, memoryHistoryPreviewSnapshot, Infinity);
    }

    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => {
        this.#agent = agent;
        this.#runtime = piRuntime(agent);
    };

    /** Pi answers `initialize` from its configuration without launching a process. */
    readonly getCapabilities: Adapter["getCapabilities"] = async (query) => {
        query.signal.throwIfAborted();
        return await this.#capabilities(this.#catalog());
    };

    readonly createSession: Adapter["createSession"] = (params) =>
        this.#start(params, async (agent) => {
            const response = agent.newSession({ cwd: params.scope.cwd, mcpServers: [] });
            await sessionCreationResponse(response, params.signal);
            return await response;
        });

    readonly forkSession: Adapter["forkSession"] = (params) => {
        const source = sessionIdSchema.parse(params.sourceSessionId);
        return this.#start(params, async (agent) => {
            const response = await agent.forkSession({ cwd: params.scope.cwd, sessionId: source, mcpServers: [] });
            if (response.sessionId === source) {
                throw new AcpExecutionError(
                    "Pi did not create an independent fork",
                    {},
                    "invalid_native_session_response",
                );
            }
            return response;
        });
    };

    readonly openSession: Adapter["openSession"] = (params) => this.#open(params, "resume");

    readonly openSessionWithReplay: Adapter["openSessionWithReplay"] = (params) => this.#open(params, "replay");

    readonly #open = async (params: AdapterSessionOpenParams, mode: "resume" | "replay") => {
        const sessionId = sessionIdSchema.parse(params.sessionId);
        const request = { cwd: params.scope.cwd, sessionId: sessionId, mcpServers: [] };
        const existing = this.#sessions.get(sessionId);
        existing?.assertWorkspace(workspaceOf(params.scope));
        if (existing?.available === true && mode === "resume") {
            try {
                const response = await waitForAgentOperation(existing.agent.resumeSession(request), params.signal);
                return await this.#opened(existing, params, response);
            } catch (cause) {
                await this.#release(sessionId);
                params.signal.throwIfAborted();
                throw agentOperationError(cause);
            }
        }
        // Pi replays history by restarting its process, so replay (or an unavailable client) starts a new one.
        await this.#release(sessionId);
        return await this.#start(params, async (agent) => ({
            ...(mode === "resume" ? await agent.resumeSession(request) : await agent.loadSession(request)),
            sessionId: sessionId,
        }));
    };

    readonly #start = async (
        params: AdapterSessionCreateParams,
        start: (agent: PiAcpAgent) => Promise<PiSessionResponse & { readonly sessionId: string }>,
    ): Promise<AdapterSessionOpened> => {
        const { session, response } = await startPiSession(
            {
                runtime: this.#runtime,
                workspace: workspaceOf(params.scope),
                callbacks: piSessionCallbacks(params, params.scope.externalizeUpdate),
                externalizer: this.#dependencies.contentExternalizer,
                signal: AbortSignal.any([
                    params.signal,
                    this.#lifetime.signal,
                    AbortSignal.timeout(START_TIMEOUT_MILLISECONDS),
                ]),
            },
            start,
        );
        if (this.#lifetime.signal.aborted || this.#sessions.has(session.sessionId)) {
            await session.dispose("graceful");
            this.#lifetime.signal.throwIfAborted();
            throw new AcpExecutionError("Another writer is using this native session", {}, "session_busy");
        }
        this.#sessions.set(session.sessionId, session);
        try {
            return await this.#opened(session, params, response);
        } catch (cause) {
            await this.#release(session.sessionId);
            throw cause;
        }
    };

    readonly #opened = async (
        session: HarnessSession<PiAcpAgent>,
        params: AdapterSessionCreateParams,
        response: PiSessionResponse,
    ): Promise<AdapterSessionOpened> => {
        const initialized = await session.agent.initialize({ protocolVersion: PROTOCOL_VERSION });
        return {
            sessionId: session.sessionId,
            capabilities: normalizeAcpCapabilities(initialized),
            configOptions: normalizeSessionConfiguration(response),
            agentName: truncate(initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? "pi", 255),
            agentVersion: params.scope.agent.agentVersion,
            agentSettingsModelEffort: null,
        };
    };

    readonly #session = (target: AdapterSessionTarget): HarnessSession<PiAcpAgent> => {
        this.#lifetime.signal.throwIfAborted();
        const session = this.#sessions.get(sessionIdSchema.parse(target.sessionId));
        if (session === undefined) {
            throw new AcpExecutionError("The native session is not active", {}, "invalid_agent_session");
        }
        session.assertWorkspace(workspaceOf(target));
        if (!session.available) {
            throw new AcpExecutionError("The Pi session is unavailable", {}, "session_busy");
        }
        return session;
    };

    readonly prompt: Adapter["prompt"] = async (params) => {
        const session = this.#session(params);
        const capabilities = await this.#capabilities(session.agent);
        const response = await session.prompt(
            { prompt: buildPromptContent(params.content, capabilities) },
            params.signal,
        );
        const decoded = decodeAgentPromptResponse(response);
        return {
            stopReason: decoded.stopReason,
            ...(decoded.usage === undefined ? {} : { usage: decoded.usage }),
            ...(decoded._meta === undefined ? {} : { _meta: decoded._meta }),
        };
    };

    readonly steer: Adapter["steer"] = async (params) => {
        const session = this.#session(params);
        const capabilities = await this.#capabilities(session.agent);
        const response = await session.agent
            .steer(
                {
                    sessionId: session.sessionId,
                    prompt: buildPromptContent(params.content, capabilities),
                    _meta: { steering: { idleBehavior: "promptRequired" } },
                },
                params.signal,
            )
            .catch((cause: unknown) => {
                params.signal.throwIfAborted();
                throw agentOperationError(cause);
            });
        if (response.outcome === "promptRequired") {
            throw new AcpExecutionError(
                "The target turn finished before steering could be injected",
                {},
                "steering_target_unavailable",
            );
        }
        return response;
    };

    readonly cancel: Adapter["cancel"] = async (params) => {
        params.signal.throwIfAborted();
        const session = this.#session(params);
        const outcome = await session.cancel(params.signal);
        if (outcome === "closed") {
            await this.#release(session.sessionId);
        }
        return outcome;
    };

    readonly releaseSession: Adapter["releaseSession"] = async (params) => {
        const sessionId = sessionIdSchema.parse(params.sessionId);
        const session = this.#sessions.get(sessionId);
        session?.assertWorkspace(workspaceOf(params));
        await this.#release(sessionId);
        params.signal.throwIfAborted();
    };

    readonly closeSession: Adapter["closeSession"] = this.releaseSession;

    /** Pi records its native history in a session file, so the revision is read without its process. */
    readonly readNativeHistoryRevision: Adapter["readNativeHistoryRevision"] = async (params) => {
        const session = this.#session(params);
        const revision = await waitForAgentOperation(
            session.agent.readSessionRevision({ sessionId: session.sessionId }),
            AbortSignal.any([params.signal, AbortSignal.timeout(30_000)]),
        );
        if (revision.latestEntryId.length > 256) {
            throw new AcpExecutionError(
                "Pi returned an invalid native history revision",
                {},
                "invalid_native_session_response",
            );
        }
        return { kind: "tracked", latestEntryId: revision.latestEntryId };
    };

    readonly #release = async (sessionId: SessionId): Promise<void> => {
        const session = this.#sessions.get(sessionId);
        if (session !== undefined) {
            this.#sessions.delete(sessionId);
            await session.dispose("graceful");
        }
    };

    readonly renameSession: Adapter["renameSession"] = async (params) => {
        this.#session(params);
        if (truncate(params.title, 500).length === 0) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
    };

    /** A cancelled caller stops waiting; the session and its native configuration stay intact. */
    readonly configureSession: Adapter["configureSession"] = async (params) => {
        const session = this.#session(params);
        const { sessionId, agent } = session;
        const selection = params.selection;
        const configure = async (): Promise<readonly SessionConfigOption[]> => {
            const configuration = await agent.sessionConfiguration(sessionId);
            const option = normalizeSessionConfiguration(configuration).find(
                (option) => option.id === selection.configId,
            );
            if (
                option === undefined ||
                option.type !== "select" ||
                selection.type !== "select" ||
                option.values.length < 2
            ) {
                throw new AcpExecutionError(
                    "The requested configuration option is unavailable",
                    {},
                    "invalid_session_configuration",
                );
            }
            if (!option.values.some((entry) => entry.value === selection.value)) {
                throw new AcpConfigurationValueUnavailableError(
                    selection.configId,
                    selection.value,
                    option.values.map((entry) => entry.value),
                );
            }
            if (option.category === "mode") {
                await agent.setSessionMode({ sessionId: sessionId, modeId: selection.value });
            } else {
                await agent.setSessionConfigOption({
                    sessionId: sessionId,
                    configId: selection.configId,
                    value: selection.value,
                });
            }
            const applied = await agent.sessionConfiguration(sessionId);
            const configOptions = normalizeSessionConfiguration(applied);
            if (
                !configOptions.some(
                    (option) =>
                        option.id === selection.configId &&
                        option.type === "select" &&
                        option.currentValue === selection.value,
                )
            ) {
                throw new AcpExecutionError(
                    "Pi did not apply the requested configuration",
                    {},
                    "invalid_session_configuration",
                );
            }
            return configOptions;
        };
        return await waitForAgentOperation(configure(), params.signal);
    };

    /** Pi lists sessions from its session files without launching a process. */
    readonly listSessions: Adapter["listSessions"] = async ({ query, cursor }) => {
        query.signal.throwIfAborted();
        const result = await this.#catalog().listSessions({ ...(cursor === null ? {} : { cursor }) });
        query.signal.throwIfAborted();
        const decoded = nativeSessionPageSchema.safeParse(result);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "Pi returned an invalid native session list",
                { cause: decoded.error },
                "invalid_native_session_response",
            );
        }
        return decoded.data;
    };

    readonly findSession: Adapter["findSession"] = ({ query, sessionId, budget }) =>
        findNativeSession(this.listSessions, query, sessionId, budget);

    /** Pi replays a saved session only by loading it, so previews run one transient Pi client. */
    readonly readSessionHistory: Adapter["readSessionHistory"] = async ({ query, request }) => {
        const scoped = {
            ...query,
            agent: this.#agent,
            signal: AbortSignal.any([
                query.signal,
                this.#lifetime.signal,
                AbortSignal.timeout(START_TIMEOUT_MILLISECONDS),
            ]),
        };
        const runtime = this.#runtime;
        return await this.#previews.read({
            identity: { kind: "fresh" },
            query: scoped,
            request,
            create: async (params, lifetime, signal) => {
                const callbacks = piClientCallbacks(params, this.#dependencies.contentExternalizer, lifetime);
                const client = await createPiClient(runtime, callbacks, signal);
                return {
                    client,
                    load: (id) => client.loadSession({ cwd: scoped.cwd, sessionId: id, mcpServers: [] }),
                    drained: callbacks.drained,
                };
            },
        });
    };

    readonly close = async (): Promise<void> => {
        this.#lifetime.abort(new DOMException("The Pi adapter closed", "AbortError"));
        const sessions = [...this.#sessions.keys()];
        await runCleanup(...sessions.map((sessionId) => () => this.#release(sessionId)), () => this.#previews.close());
    };

    readonly #catalog = (): PiAcpAgent =>
        createPiCatalogClient(this.#runtime, {
            sessionUpdate: async () => undefined,
            startUserMessage: () => undefined,
            requestPermission: rejectCatalogInteraction,
            requestElicitation: rejectCatalogInteraction,
        });

    readonly #capabilities = async (agent: PiAcpAgent) =>
        normalizeAcpCapabilities(await agent.initialize({ protocolVersion: PROTOCOL_VERSION }));
}

async function rejectCatalogInteraction(): Promise<never> {
    throw new AcpExecutionError("Pi catalog queries cannot request user interaction", {}, "invalid_agent_session");
}
