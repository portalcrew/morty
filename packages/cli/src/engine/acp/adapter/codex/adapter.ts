import { createHash } from "node:crypto";
import { decodeAgentPromptResponse } from "@portalcrew/morty-client/protocol";
import { revalidateExecutable } from "../../../util/process/executable.ts";
import { runCleanup } from "../../../util/run-cleanup.ts";
import { truncate } from "../../../util/value-utils.ts";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp-error.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { buildPromptContent } from "../../client/prompt-content.ts";
import { agentOperationError, waitForAgentOperation } from "../../connection/agent-operation.ts";
import { CodexAcpAgent } from "../../harness/codex/agent.ts";
import type {
    Adapter,
    AdapterDependencies,
    AdapterSessionCreateParams,
    AdapterSessionOpenParams,
    AdapterSessionTarget,
} from "../../native-history/preview-contract.ts";
import { nativeSessionPageSchema, type SessionId, sessionIdSchema } from "../../protocol/native-session.ts";
import { normalizeAcpCapabilities, restrictAcpSessionCapabilities } from "../../protocol/session-capabilities.ts";
import { normalizeSessionConfiguration } from "../../protocol/session-configuration.ts";
import { harnessSessionCallbacks } from "../harness-client-events.ts";
import { HarnessHistoryPreviews } from "../harness-history-previews.ts";
import { HarnessSession } from "../harness-session.ts";
import { sessionCreationResponse } from "../lifecycle-output.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { openPreviewEventCache } from "../preview-event-cache.ts";
import { codexClientCallbacks } from "./client-callbacks.ts";
import { createCodexClient } from "./create-client.ts";

type CodexSession = HarnessSession<CodexAcpAgent>;
type CodexOpened = Awaited<ReturnType<CodexAcpAgent["newSession"]>>;

export class CodexAdapter implements Adapter {
    readonly #sessions = new Map<SessionId, CodexSession>();
    readonly #lifetime = new AbortController();
    readonly #previews: HarnessHistoryPreviews;
    readonly #dependencies: AdapterDependencies;
    #agent: AcpAgentDefinition;

    constructor(agent: AcpAgentDefinition, dependencies: AdapterDependencies) {
        this.#agent = agent;
        this.#dependencies = dependencies;
        this.#previews = new HarnessHistoryPreviews(dependencies.processes, openPreviewEventCache, 16);
    }
    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => {
        this.#agent = agent;
    };
    readonly #signal = (signal: AbortSignal, milliseconds = 60_000) =>
        AbortSignal.any([signal, this.#lifetime.signal, AbortSignal.timeout(milliseconds)]);
    readonly getCapabilities: Adapter["getCapabilities"] = async (query) => {
        query.signal.throwIfAborted();
        return normalizeAcpCapabilities(CodexAcpAgent.capabilities());
    };
    readonly #start = async (
        params: AdapterSessionCreateParams,
        open: (agent: CodexAcpAgent, signal: AbortSignal) => Promise<CodexOpened>,
    ) => {
        // The Runtime adds per-session launch values without changing the catalog identity.
        const runtime = params.scope.agent;
        const signal = this.#signal(params.signal);
        const { session, response } = await HarnessSession.start(
            {
                workspace: { cwd: params.scope.cwd },
                signal,
                create: async (lifetime) => {
                    const callbacks = codexClientCallbacks(
                        harnessSessionCallbacks(params, params.scope.externalizeUpdate),
                        this.#dependencies.contentExternalizer,
                        lifetime,
                    );
                    const agent = await createCodexClient(
                        runtime,
                        {
                            cwd: params.scope.cwd,
                            ...callbacks,
                            onBackgroundActivity: (activity) => {
                                if (!lifetime.signal.aborted) {
                                    params.onBackgroundActivity?.(activity);
                                }
                            },
                            onPromptDelegation: async (stage) => await params.onPromptDelegation?.(stage),
                        },
                        signal,
                    );
                    return { agent, drained: callbacks.drained };
                },
            },
            open,
        );
        if (this.#lifetime.signal.aborted || this.#sessions.has(session.sessionId)) {
            await session.dispose("graceful");
            this.#lifetime.signal.throwIfAborted();
            throw new AcpExecutionError("Another writer is using this session", {}, "session_busy");
        }
        this.#sessions.set(session.sessionId, session);
        try {
            return this.#opened(session, params, response);
        } catch (cause) {
            await this.#release(session.sessionId, "graceful");
            throw cause;
        }
    };
    readonly #opened = (session: CodexSession, params: AdapterSessionCreateParams, response: CodexOpened) => ({
        sessionId: session.sessionId,
        capabilities: restrictAcpSessionCapabilities(normalizeAcpCapabilities(CodexAcpAgent.capabilities()), response),
        configOptions: normalizeSessionConfiguration(response),
        agentName: "Codex",
        agentVersion: params.scope.agent.agentVersion || CodexAcpAgent.capabilities().agentInfo.version,
        agentSettingsModelEffort: session.agent.agentSettingsModelEffort(),
    });
    readonly createSession: Adapter["createSession"] = (params) =>
        this.#start(params, async (agent, signal) => {
            const response = agent.newSession({ cwd: params.scope.cwd }, signal);
            await sessionCreationResponse(response, signal);
            return await response;
        });
    readonly forkSession: Adapter["forkSession"] = (params) =>
        this.#start(params, async (agent, signal) => {
            const source = sessionIdSchema.parse(params.sourceSessionId);
            const response = await agent.forkSession({ cwd: params.scope.cwd, sessionId: source }, signal);
            if (response.sessionId === source) {
                throw new AcpExecutionError(
                    "Codex did not create an independent fork",
                    {},
                    "invalid_native_session_response",
                );
            }
            return response;
        });
    readonly openSession: Adapter["openSession"] = (params) => this.#open(params, false);
    readonly openSessionWithReplay: Adapter["openSessionWithReplay"] = (params) => this.#open(params, true);
    readonly #open = async (params: AdapterSessionOpenParams, replay: boolean) => {
        const sessionId = sessionIdSchema.parse(params.sessionId);
        const request = { cwd: params.scope.cwd, sessionId };
        const existing = this.#sessions.get(sessionId);
        existing?.assertWorkspace(params.scope);
        if (existing?.available) {
            try {
                const signal = this.#signal(params.signal);
                // Replaying on the current app-server preserves its writer/borrower access mode.
                if (replay) {
                    await waitForAgentOperation(existing.agent.readHistory(sessionId, signal), signal);
                }
                await existing.drained(signal);
                return this.#opened(existing, params, existing.agent.sessionState());
            } catch (cause) {
                await this.#release(sessionId, "force");
                params.signal.throwIfAborted();
                throw agentOperationError(cause);
            }
        }
        await this.#release(sessionId, "graceful");
        return await this.#start(params, (agent, signal) =>
            replay ? agent.loadSession(request, signal) : agent.resumeSession(request, signal),
        );
    };
    readonly #session = (target: AdapterSessionTarget): CodexSession => {
        this.#lifetime.signal.throwIfAborted();
        const session = this.#sessions.get(sessionIdSchema.parse(target.sessionId));
        if (session === undefined) {
            throw new AcpExecutionError("The session is not active", {}, "invalid_agent_session");
        }
        session.assertWorkspace(target);
        if (!session.available) {
            throw new AcpExecutionError("The Codex session is unavailable", {}, "session_busy");
        }
        return session;
    };
    readonly prompt: Adapter["prompt"] = async (params) => {
        const response = await this.#session(params).prompt(
            { prompt: buildPromptContent(params.content, normalizeAcpCapabilities(CodexAcpAgent.capabilities())) },
            params.signal,
        );
        try {
            const decoded = decodeAgentPromptResponse(response);
            return {
                stopReason: decoded.stopReason,
                ...(decoded.usage === undefined ? {} : { usage: decoded.usage }),
                ...(decoded._meta === undefined ? {} : { _meta: decoded._meta }),
            };
        } catch (cause) {
            throw new AcpExecutionError(
                "The harness returned an invalid prompt response",
                { cause },
                "acp_invalid_prompt_response",
            );
        }
    };
    readonly steer: Adapter["steer"] = async (params) => {
        const session = this.#session(params);
        if (!session.agent.runsTurns()) {
            throw new AcpExecutionError(
                "The selected agent does not support mid-turn steering",
                {},
                "steering_unsupported",
            );
        }
        const signal = this.#signal(params.signal, 30_000);
        const response = await waitForAgentOperation(
            session.agent.steer(
                {
                    sessionId: session.sessionId,
                    prompt: buildPromptContent(params.content, normalizeAcpCapabilities(CodexAcpAgent.capabilities())),
                    _meta: { steering: { idleBehavior: "promptRequired" } },
                },
                signal,
            ),
            signal,
        );
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
        const session = this.#session(params);
        params.signal.throwIfAborted();
        if (!session.agent.runsTurns()) {
            return await session.cancel(params.signal);
        }
        await this.#release(session.sessionId, "force");
        return "closed";
    };
    readonly #release = async (id: SessionId, mode: "graceful" | "force"): Promise<void> => {
        const session = this.#sessions.get(id);
        if (session !== undefined) {
            this.#sessions.delete(id);
            await session.dispose(mode);
        }
    };
    readonly releaseSession: Adapter["releaseSession"] = async (params) => {
        const id = sessionIdSchema.parse(params.sessionId);
        this.#sessions.get(id)?.assertWorkspace(params);
        await this.#release(id, "graceful");
        params.signal.throwIfAborted();
    };
    readonly closeSession: Adapter["closeSession"] = this.releaseSession;
    readonly readNativeHistoryRevision: Adapter["readNativeHistoryRevision"] = async ({ signal }) => {
        signal.throwIfAborted();
        return { kind: "untracked" };
    };
    readonly renameSession: Adapter["renameSession"] = async (params) => {
        this.#session(params);
        if (!truncate(params.title, 500)) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
    };
    readonly configureSession: Adapter["configureSession"] = async (params) => {
        params.signal.throwIfAborted();
        const session = this.#session(params);
        const { selection } = params;
        const current = normalizeSessionConfiguration(session.agent.sessionConfiguration());
        const option = current.find((option) => option.id === selection.configId);
        if (!option || option.type !== selection.type || (option.type === "select" && option.values.length < 2)) {
            throw new AcpExecutionError(
                "The requested configuration option is unavailable",
                {},
                "invalid_session_configuration",
            );
        }
        if (
            option.type === "select" &&
            selection.type === "select" &&
            !option.values.some((value) => value.value === selection.value)
        ) {
            throw new AcpConfigurationValueUnavailableError(
                selection.configId,
                selection.value,
                option.values.map((value) => value.value),
            );
        }
        if (option.category === "mode" && selection.type === "select") {
            session.agent.setSessionMode({ modeId: selection.value });
        } else {
            session.agent.setSessionConfigOption({
                configId: selection.configId,
                value: selection.type === "boolean" ? selection.booleanValue : selection.value,
            });
        }
        const applied = normalizeSessionConfiguration(session.agent.sessionConfiguration());
        if (
            !applied.some(
                (value) =>
                    value.id === selection.configId &&
                    value.type === selection.type &&
                    (value.type === "boolean" && selection.type === "boolean"
                        ? value.booleanValue === selection.booleanValue
                        : value.type === "select" &&
                          selection.type === "select" &&
                          value.currentValue === selection.value),
            )
        ) {
            throw new AcpExecutionError(
                "The Agent did not apply the requested session configuration",
                {},
                "invalid_session_configuration",
            );
        }
        return applied;
    };
    readonly listSessions: Adapter["listSessions"] = async ({ query, cursor }) => {
        const signal = this.#signal(query.signal, 30_000);
        const agent = this.#agent;
        return await this.#dependencies.processes.runTransient(
            signal,
            async () => {
                const reject = async (): Promise<never> => {
                    throw new AcpExecutionError(
                        "Catalog queries cannot request interaction",
                        {},
                        "invalid_agent_session",
                    );
                };
                const client = await createCodexClient(
                    agent,
                    {
                        cwd: query.cwd,
                        onSessionUpdate: reject,
                        interactions: { onPermission: reject, onElicitation: reject },
                    },
                    signal,
                );
                return { client, closeProcess: () => client.dispose("force") };
            },
            async ({ client }) => nativeSessionPageSchema.parse(await client.listSessions(cursor, signal)),
            (runtime) => runtime.closeProcess(),
        );
    };
    readonly findSession: Adapter["findSession"] = ({ query, sessionId, budget }) =>
        findNativeSession(this.listSessions, query, sessionId, budget);
    readonly readSessionHistory: Adapter["readSessionHistory"] = async ({ query, request }) => {
        const runtime = query.agent;
        query.signal.throwIfAborted();
        sessionIdSchema.parse(request.sessionId);
        if (query.agent.harness !== "codex" || runtime.harness !== "codex") {
            throw new AcpExecutionError(
                "The Codex adapter cannot preview history for another agent.",
                {},
                "agent_adapter_mismatch",
            );
        }
        if (!(await revalidateExecutable(runtime.agentIdentity))) {
            throw new AcpExecutionError(
                "The local Codex executable changed. Restart Morty to discover it again.",
                {},
                "agent_executable_changed",
            );
        }
        return this.#previews.read({
            query: { ...query, agent: runtime, signal: this.#signal(query.signal) },
            request,
            // Unchanged native content keeps the same event identities across refreshed pages.
            identity: {
                kind: "content",
                generationId: (sessionId, events) =>
                    createHash("sha256").update(sessionId).update("\0").update(JSON.stringify(events)).digest("hex"),
            },
            create: async (params, lifetime, signal) => {
                const callbacks = codexClientCallbacks(params, this.#dependencies.contentExternalizer, lifetime);
                const client = await createCodexClient(runtime, { cwd: query.cwd, ...callbacks }, signal);
                return { client, load: (id, signal) => client.readHistory(id, signal), drained: callbacks.drained };
            },
        });
    };
    readonly close = async (): Promise<void> => {
        this.#lifetime.abort(new DOMException("The Codex adapter closed", "AbortError"));
        await runCleanup(...[...this.#sessions.keys()].map((id) => () => this.#release(id, "graceful")), () =>
            this.#previews.close(),
        );
    };
}
