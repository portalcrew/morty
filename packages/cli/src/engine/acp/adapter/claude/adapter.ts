import { decodeAgentPromptResponse, type SessionConfigOption } from "@portalcrew/morty-client/protocol";
import { runCleanup } from "../../../util/run-cleanup.ts";
import { truncate } from "../../../util/value-utils.ts";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../acp-error.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { buildPromptContent } from "../../client/prompt-content.ts";
import { agentOperationError, waitForAgentOperation } from "../../connection/agent-operation.ts";
import type { ClaudeAcpAgent } from "../../harness/claude/upstream/dist/acp-agent.js";
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
import { harnessSessionCallbacks } from "../harness-client-events.ts";
import { HarnessHistoryPreviews } from "../harness-history-previews.ts";
import { HarnessSession } from "../harness-session.ts";
import { sessionCreationResponse } from "../lifecycle-output.ts";
import { findNativeSession } from "../native-session-lookup.ts";
import { claudeClientCallbacks } from "./client-callbacks.ts";
import { createClaudeCatalogClient, createClaudeClient, initializeClaudeClient } from "./create-client.ts";

type ClaudeSession = HarnessSession<ClaudeAcpAgent>;

export class ClaudeAdapter implements Adapter {
    readonly #sessions = new Map<SessionId, ClaudeSession>();
    readonly #lifetime = new AbortController();
    readonly #previews: HarnessHistoryPreviews;
    readonly dependencies: AdapterDependencies;
    #agent: AcpAgentDefinition;

    constructor(agent: AcpAgentDefinition, dependencies: AdapterDependencies) {
        this.dependencies = dependencies;
        this.#agent = agent;
        this.#previews = new HarnessHistoryPreviews(dependencies.processes, memoryHistoryPreviewSnapshot, Infinity);
    }

    readonly refreshAgent: Adapter["refreshAgent"] = (agent) => {
        this.#agent = agent;
    };
    readonly #signal = (signal: AbortSignal, milliseconds = 60_000) =>
        AbortSignal.any([signal, this.#lifetime.signal, AbortSignal.timeout(milliseconds)]);

    readonly #catalog = () => {
        const reject = async (): Promise<never> => {
            throw new AcpExecutionError("Catalog queries cannot request interaction", {}, "invalid_agent_session");
        };
        return createClaudeCatalogClient(this.#agent, {
            sessionUpdate: reject,
            requestPermission: reject,
            createElicitation: reject,
            completeElicitation: reject,
            readTextFile: reject,
            writeTextFile: reject,
            extNotification: reject,
        });
    };
    readonly getCapabilities: Adapter["getCapabilities"] = async (query) => {
        query.signal.throwIfAborted();
        return normalizeAcpCapabilities(await initializeClaudeClient(this.#catalog()));
    };
    readonly #capabilities = async (agent: ClaudeAcpAgent) =>
        normalizeAcpCapabilities(await initializeClaudeClient(agent));

    readonly #start = async (
        params: AdapterSessionCreateParams,
        open: (
            agent: ClaudeAcpAgent,
            signal: AbortSignal,
        ) => Promise<{ readonly sessionId: string; readonly configOptions?: unknown; readonly modes?: unknown }>,
    ): Promise<AdapterSessionOpened> => {
        const signal = this.#signal(params.signal);
        const runtime = this.#agent;
        const { session, response } = await HarnessSession.start(
            {
                workspace: { cwd: params.scope.cwd },
                signal,
                create: async (lifetime) => {
                    const callbacks = claudeClientCallbacks(
                        harnessSessionCallbacks(params, params.scope.externalizeUpdate),
                        this.dependencies.contentExternalizer,
                        lifetime,
                    );
                    const agent = await createClaudeClient(runtime, callbacks, signal, (activity) => {
                        if (!lifetime.signal.aborted) {
                            params.onBackgroundActivity?.(activity);
                        }
                    });
                    await initializeClaudeClient(agent);
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
            return await this.#opened(session, params, response);
        } catch (cause) {
            await this.#release(session.sessionId);
            throw cause;
        }
    };
    readonly #opened = async (
        session: ClaudeSession,
        params: AdapterSessionCreateParams,
        response: unknown,
    ): Promise<AdapterSessionOpened> => {
        const initialized = await initializeClaudeClient(session.agent);
        return {
            sessionId: session.sessionId,
            capabilities: normalizeAcpCapabilities(initialized),
            configOptions: normalizeSessionConfiguration(response),
            agentName: truncate(initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? "claude", 255),
            agentVersion: params.scope.agent.agentVersion,
            agentSettingsModelEffort: null,
        };
    };

    readonly createSession: Adapter["createSession"] = (params) =>
        this.#start(params, async (agent, signal) => {
            const response = agent.newSession({ cwd: params.scope.cwd, mcpServers: [] });
            await sessionCreationResponse(response, signal);
            return await response;
        });
    readonly forkSession: Adapter["forkSession"] = (params) =>
        this.#start(params, async (agent, signal) => {
            const source = sessionIdSchema.parse(params.sourceSessionId);
            const response = await agent.unstable_forkSession(
                { cwd: params.scope.cwd, sessionId: source, mcpServers: [] },
                signal,
            );
            if (response.sessionId === source) {
                throw new AcpExecutionError(
                    "Claude did not create an independent fork",
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
        const request = { cwd: params.scope.cwd, sessionId, mcpServers: [] };
        const existing = this.#sessions.get(sessionId);
        existing?.assertWorkspace(params.scope);
        if (existing?.available) {
            try {
                const signal = this.#signal(params.signal);
                // Claude can replay on its current SDK query. Replacing it after resume would lose
                // the interrupted-task recovery updates produced by that first query.
                const response = await waitForAgentOperation(
                    replay ? existing.agent.loadSession(request, signal) : existing.agent.resumeSession(request),
                    signal,
                );
                await existing.drained(signal);
                return await this.#opened(existing, params, response);
            } catch (cause) {
                await this.#release(sessionId);
                params.signal.throwIfAborted();
                throw agentOperationError(cause);
            }
        }
        await this.#release(sessionId);
        return await this.#start(params, async (agent, signal) => ({
            ...(replay ? await agent.loadSession(request, signal) : await agent.resumeSession(request)),
            sessionId,
        }));
    };

    readonly #session = (target: AdapterSessionTarget): ClaudeSession => {
        this.#lifetime.signal.throwIfAborted();
        const session = this.#sessions.get(sessionIdSchema.parse(target.sessionId));
        if (session === undefined) {
            throw new AcpExecutionError("The session is not active", {}, "invalid_agent_session");
        }
        session.assertWorkspace(target);
        if (!session.available) {
            throw new AcpExecutionError("The Claude session is unavailable", {}, "session_busy");
        }
        return session;
    };
    readonly prompt: Adapter["prompt"] = async (params) => {
        const session = this.#session(params);
        const response = await session.prompt(
            { prompt: buildPromptContent(params.content, await this.#capabilities(session.agent)) },
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
        const response = await waitForAgentOperation(
            session.agent.steer({
                sessionId: session.sessionId,
                prompt: buildPromptContent(params.content, await this.#capabilities(session.agent)),
                _meta: { steering: { idleBehavior: "promptRequired" } },
            }),
            this.#signal(params.signal, 30_000),
        );
        switch (response.outcome) {
            case "injected":
                return response;
            case "startedNewTurn":
                // Requesting `promptRequired` excludes this outcome; an Agent that still reports it broke the contract.
                throw new AcpExecutionError(
                    "ACP agent returned an invalid steering response",
                    {},
                    "acp_invalid_steering_response",
                );
            case "promptRequired":
                throw new AcpExecutionError(
                    "The target turn finished before steering could be injected",
                    {},
                    "steering_target_unavailable",
                );
        }
    };
    readonly cancel: Adapter["cancel"] = async (params) => {
        const session = this.#session(params);
        const outcome = await session.cancel(params.signal);
        if (outcome === "closed") {
            await this.#release(session.sessionId);
        }
        return outcome;
    };
    readonly #release = async (sessionId: SessionId): Promise<void> => {
        const session = this.#sessions.get(sessionId);
        if (session !== undefined) {
            this.#sessions.delete(sessionId);
            await session.dispose("graceful");
        }
    };
    readonly releaseSession: Adapter["releaseSession"] = async (params) => {
        const id = sessionIdSchema.parse(params.sessionId);
        this.#sessions.get(id)?.assertWorkspace(params);
        await this.#release(id);
        params.signal.throwIfAborted();
    };
    readonly closeSession: Adapter["closeSession"] = async (params) => {
        const id = sessionIdSchema.parse(params.sessionId);
        const session = this.#sessions.get(id);
        if (session === undefined) {
            params.signal.throwIfAborted();
            return;
        }
        session.assertWorkspace(params);
        try {
            await waitForAgentOperation(
                session.agent.closeSession({ sessionId: id }),
                this.#signal(params.signal, 1_000),
            );
        } catch {
            params.signal.throwIfAborted();
        } finally {
            await this.#release(id);
        }
    };
    readonly readNativeHistoryRevision: Adapter["readNativeHistoryRevision"] = async (params) => {
        const session = this.#session(params);
        const signal = this.#signal(params.signal, 30_000);
        const revision = await waitForAgentOperation(
            session.agent.readSessionRevision({ sessionId: session.sessionId }, signal),
            signal,
        );
        if (revision.latestEntryId.length > 256) {
            throw new AcpExecutionError(
                "Claude returned an invalid history revision",
                {},
                "invalid_native_session_response",
            );
        }
        return { kind: "tracked", latestEntryId: revision.latestEntryId };
    };
    readonly renameSession: Adapter["renameSession"] = async (params) => {
        const session = this.#session(params);
        const title = truncate(params.title, 500);
        if (!title) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
        try {
            await waitForAgentOperation(
                session.agent.renameSession({ sessionId: session.sessionId, title }),
                this.#signal(params.signal, 30_000),
            );
        } catch (cause) {
            params.signal.throwIfAborted();
            if (cause instanceof AcpExecutionError) {
                throw cause;
            }
            throw new AcpExecutionError("The Agent could not rename the Session", { cause }, "session_rename_failed");
        }
    };
    readonly configureSession: Adapter["configureSession"] = async (
        params,
    ): Promise<readonly SessionConfigOption[]> => {
        const session = this.#session(params);
        const { selection } = params;
        const configure = async () => {
            const current = normalizeSessionConfiguration(session.agent.sessionConfiguration(session.sessionId));
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
                await session.agent.setSessionMode({ sessionId: session.sessionId, modeId: selection.value });
            } else {
                await session.agent.setSessionConfigOption({
                    sessionId: session.sessionId,
                    configId: selection.configId,
                    ...(selection.type === "boolean"
                        ? { type: "boolean", value: selection.booleanValue }
                        : { value: selection.value }),
                });
            }
            const applied = normalizeSessionConfiguration(session.agent.sessionConfiguration(session.sessionId));
            const value = applied.find((value) => value.id === selection.configId);
            if (
                !value ||
                value.type !== selection.type ||
                (value.type === "select" && selection.type === "select" && value.currentValue !== selection.value) ||
                (value.type === "boolean" &&
                    selection.type === "boolean" &&
                    value.booleanValue !== selection.booleanValue)
            ) {
                throw new AcpExecutionError(
                    "The Agent did not apply the requested session configuration",
                    {},
                    "invalid_session_configuration",
                );
            }
            return applied;
        };
        return await waitForAgentOperation(configure(), this.#signal(params.signal, 30_000));
    };
    readonly listSessions: Adapter["listSessions"] = async ({ query, cursor }) => {
        const signal = this.#signal(query.signal, 30_000);
        const response = await waitForAgentOperation(
            this.#catalog().listSessions({ ...(cursor === null ? {} : { cursor }) }, signal),
            signal,
        );
        const decoded = nativeSessionPageSchema.safeParse(response);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "Claude returned an invalid session list",
                { cause: decoded.error },
                "invalid_native_session_response",
            );
        }
        return decoded.data;
    };
    readonly findSession: Adapter["findSession"] = ({ query, sessionId, budget }) =>
        findNativeSession(this.listSessions, query, sessionId, budget);
    readonly readSessionHistory: Adapter["readSessionHistory"] = ({ query, request }) => {
        const runtime = this.#agent;
        const scoped = { ...query, agent: runtime, signal: this.#signal(query.signal) };
        return this.#previews.read({
            identity: { kind: "fresh" },
            query: scoped,
            request,
            create: async (params, lifetime, signal) => {
                const callbacks = claudeClientCallbacks(params, this.dependencies.contentExternalizer, lifetime);
                const client = await createClaudeClient(runtime, callbacks, signal);
                await initializeClaudeClient(client);
                return {
                    client,
                    load: (id, signal) =>
                        client.loadSession({ cwd: scoped.cwd, sessionId: id, mcpServers: [] }, signal),
                    drained: callbacks.drained,
                };
            },
        });
    };
    readonly close = async (): Promise<void> => {
        this.#lifetime.abort(new DOMException("The Claude adapter closed", "AbortError"));
        await runCleanup(...[...this.#sessions.keys()].map((id) => () => this.#release(id)), () =>
            this.#previews.close(),
        );
    };
}
