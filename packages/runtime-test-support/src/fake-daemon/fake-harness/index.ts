import * as acp from "@agentclientprotocol/sdk/unstable";
import type { SessionCapabilities } from "@morty-build/client/protocol";
import type { PromptDelegationStage } from "../../../../cli/src/engine/acp/agent/agent-lifecycle.ts";
import type { FakeAgentHarnessOptions, HarnessOutput, HarnessReplyPlan } from "./model.ts";

type FakeHarnessEndpointTermination = { readonly kind: "closed" };

export interface FakeHarnessEndpoint {
    readonly terminated: Promise<FakeHarnessEndpointTermination>;
    readonly app: () => ReturnType<typeof acp.agent>;
    readonly initialize: (signal: AbortSignal) => Promise<void>;
    readonly close: () => Promise<void>;
}

export const fakeHarnessCapabilities: SessionCapabilities = {
    audioPrompt: false,
    closeSession: true,
    deleteSession: false,
    embeddedContextPrompt: true,
    imagePrompt: true,
    listSessions: true,
    loadSession: true,
    promptQueueing: true,
    renameSession: true,
    resumeSession: true,
    steering: true,
    unstableForkSession: true,
};

function configOptions(model: string): acp.SessionConfigOption[] {
    return [
        {
            category: "model",
            currentValue: model,
            description: "Model used by the controlled ACP harness",
            id: "model",
            name: "Model",
            options: [
                { name: "Test Small", value: "test-small" },
                { name: "Test Large", value: "test-large" },
            ],
            type: "select",
        },
    ];
}

interface ActiveReply {
    readonly userMessageId: string;
    readonly prompt: string;
    readonly sessionId: string;
    readonly turnNumber: number;
    readonly send: (notification: acp.SessionNotification) => Promise<void>;
    readonly delegate: (stage: PromptDelegationStage) => Promise<void>;
    readonly completion: PromiseWithResolvers<acp.PromptResponse>;
    readonly signal: AbortSignal;
    outputSequence: number;
}

function promptText(blocks: readonly acp.ContentBlock[]): string {
    return blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

class ControlledAgentState {
    readonly #activeByPrompt = new Map<string, ActiveReply>();
    readonly #activeBySession = new Map<string, ActiveReply>();
    readonly #activeWaiters = new Map<string, Set<(active: ActiveReply) => void>>();
    readonly #history = new Map<string, acp.SessionNotification[]>();
    readonly #models = new Map<string, string>();
    readonly #options: FakeAgentHarnessOptions;
    readonly #sessions = new Map<string, number>();
    readonly #titles = new Map<string, string>();

    constructor(options: FakeAgentHarnessOptions) {
        this.#options = options;
        for (const sessionId of options.sessionIds ?? []) {
            this.#sessions.set(sessionId, 1);
        }
    }

    readonly turnCount = (sessionId: string): number => this.#sessions.get(sessionId) ?? 0;
    readonly title = (sessionId: string): string | null => this.#titles.get(sessionId) ?? null;
    readonly rename = (sessionId: string, title: string): void => {
        if (!this.#sessions.has(sessionId)) {
            throw new Error(`The controlled Agent session is unknown: ${sessionId}`);
        }
        this.#titles.set(sessionId, title);
    };
    readonly rememberSession = (sessionId: string, turnCount = 0): void => {
        this.#sessions.set(sessionId, turnCount);
        if (!this.#history.has(sessionId)) {
            this.#history.set(sessionId, []);
        }
        if (!this.#models.has(sessionId)) {
            this.#models.set(sessionId, "test-small");
        }
    };
    readonly fork = (sourceId: string): string => {
        if (!this.#sessions.has(sourceId)) {
            throw new Error(`The controlled Agent session is unknown: ${sourceId}`);
        }
        const sessionId = crypto.randomUUID();
        this.rememberSession(sessionId, this.turnCount(sourceId));
        this.#history.set(
            sessionId,
            (this.#history.get(sourceId) ?? []).map((event) => ({ ...event, sessionId })),
        );
        this.#models.set(sessionId, this.#models.get(sourceId) ?? "test-small");
        return sessionId;
    };
    readonly configuration = (sessionId: string): acp.SessionConfigOption[] =>
        configOptions(this.#models.get(sessionId) ?? "test-small");
    readonly configure = (sessionId: string, configId: string, value: string | boolean): acp.SessionConfigOption[] => {
        if (configId === "model" && (value === "test-small" || value === "test-large")) {
            this.#models.set(sessionId, value);
        }
        return this.configuration(sessionId);
    };
    readonly sessions = (): readonly { readonly sessionId: string; readonly turnCount: number }[] =>
        Array.from(this.#sessions, ([sessionId, turnCount]) => ({ sessionId, turnCount }));
    readonly replay = async (
        sessionId: string,
        send: (notification: acp.SessionNotification) => Promise<void>,
    ): Promise<void> => {
        if (this.#activeBySession.has(sessionId)) {
            return;
        }
        for (const notification of this.#history.get(sessionId) ?? []) {
            await send(notification);
        }
    };

    readonly start = async (
        sessionId: string,
        contents: readonly acp.ContentBlock[],
        send: (notification: acp.SessionNotification) => Promise<void>,
        delegate: (stage: PromptDelegationStage) => Promise<void>,
        signal: AbortSignal,
    ): Promise<acp.PromptResponse> => {
        const turnNumber = this.turnCount(sessionId) + 1;
        const prompt = promptText(contents);
        const messageId = `user-${turnNumber.toString()}`;
        this.rememberSession(sessionId, turnNumber);
        if (this.#options.echoUserMessage !== false) {
            for (const content of contents) {
                const userUpdate = {
                    sessionId,
                    update: { content, messageId, sessionUpdate: "user_message_chunk" },
                } as const;
                this.#record(userUpdate);
                await send(userUpdate);
            }
        }
        const completion = Promise.withResolvers<acp.PromptResponse>();
        const active: ActiveReply = {
            completion,
            outputSequence: 0,
            prompt,
            send,
            delegate,
            sessionId,
            signal,
            turnNumber,
            userMessageId: messageId,
        };
        this.#activeByPrompt.set(prompt, active);
        this.#activeBySession.set(sessionId, active);
        const waiters = this.#activeWaiters.get(prompt);
        if (waiters !== undefined) {
            this.#activeWaiters.delete(prompt);
            for (const resolve of waiters) {
                resolve(active);
            }
        }
        const abort = (): void => this.#finish(active, "cancelled");
        signal.addEventListener("abort", abort, { once: true });
        try {
            await this.#apply(active, this.#options.reply(prompt, turnNumber, "prompt"));
            return await completion.promise;
        } catch (cause) {
            // Like the Claude adapter, a failed prompt still names the user message it recorded.
            if (cause instanceof acp.RequestError) {
                const data = typeof cause.data === "object" && cause.data !== null ? cause.data : {};
                cause.data = { ...data, messageId };
            }
            throw cause;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#forget(active);
        }
    };

    readonly steer = async (sessionId: string, prompt: string): Promise<Readonly<Record<string, unknown>>> => {
        const active = this.#activeBySession.get(sessionId);
        if (active === undefined) {
            return { outcome: "promptRequired", reason: "noRunningTurn" };
        }
        const userUpdate = {
            sessionId,
            update: {
                content: { text: prompt, type: "text" },
                messageId: `user-${active.turnNumber.toString()}-steer-${crypto.randomUUID()}`,
                sessionUpdate: "user_message_chunk",
            },
        } as const;
        if (this.#options.echoUserMessage !== false) {
            this.#record(userUpdate);
            await active.send(userUpdate);
        }
        await this.#apply(active, this.#options.reply(prompt, active.turnNumber, "steer"));
        return { outcome: "injected", messageId: userUpdate.update.messageId };
    };

    readonly cancel = (sessionId: string): void => {
        const active = this.#activeBySession.get(sessionId);
        if (active !== undefined) {
            this.#finish(active, "cancelled");
        }
    };

    readonly continueReply = async (prompt: string, plan: HarnessReplyPlan): Promise<void> => {
        const active = await this.#active(prompt);
        await this.#apply(active, plan);
    };

    async #active(prompt: string): Promise<ActiveReply> {
        const active = this.#activeByPrompt.get(prompt);
        if (active !== undefined) {
            return active;
        }
        const waiting = Promise.withResolvers<ActiveReply>();
        const waiters = this.#activeWaiters.get(prompt) ?? new Set<(active: ActiveReply) => void>();
        waiters.add(waiting.resolve);
        this.#activeWaiters.set(prompt, waiters);
        return await waiting.promise;
    }

    async #apply(active: ActiveReply, plan: HarnessReplyPlan): Promise<void> {
        active.signal.throwIfAborted();
        for (const output of plan.output) {
            await this.#publish(active, output);
        }
        if (plan.outcome === "complete") {
            this.#finish(active, "end_turn");
        }
    }

    async #publish(active: ActiveReply, output: HarnessOutput): Promise<void> {
        if (output.kind === "delegation") {
            await active.delegate(output.stage);
            return;
        }
        active.outputSequence += 1;
        const id = `${active.sessionId}-${active.turnNumber.toString()}-${active.outputSequence.toString()}`;
        if (output.kind === "text" || output.kind === "message") {
            const notification: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    content: { text: output.text, type: "text" },
                    messageId: output.kind === "message" ? id : `assistant-${active.turnNumber.toString()}`,
                    sessionUpdate: "agent_message_chunk",
                    ...(output.kind === "message" && output.questions !== undefined
                        ? { _meta: { "morty.questions": output.questions } }
                        : {}),
                },
            };
            this.#record(notification);
            await active.send(notification);
            return;
        }
        if (output.kind === "file") {
            const notification: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    content: {
                        name: output.name,
                        type: "resource_link",
                        uri: `file:///workspace/${encodeURIComponent(output.name)}`,
                    },
                    messageId: `assistant-${active.turnNumber.toString()}`,
                    sessionUpdate: "agent_message_chunk",
                },
            };
            this.#record(notification);
            await active.send(notification);
            return;
        }
        if (output.kind === "session-title" || output.kind === "session-updated-at") {
            const notification: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    sessionUpdate: "session_info_update",
                    ...(output.kind === "session-title" ? { title: output.title } : { updatedAt: output.updatedAt }),
                },
            };
            this.#record(notification);
            await active.send(notification);
            return;
        }
        if (output.kind === "compaction-start") {
            const started: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    compactionId: `compaction-${active.turnNumber.toString()}`,
                    sessionUpdate: "compaction_update",
                    status: "in_progress",
                },
            };
            this.#record(started);
            await active.send(started);
            return;
        }
        if (output.kind === "compaction-finish") {
            const compactionId = `compaction-${active.turnNumber.toString()}`;
            const chunk: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    compactionId,
                    content: { text: output.summary, type: "text" },
                    sessionUpdate: "compaction_summary_chunk",
                },
            };
            this.#record(chunk);
            await active.send(chunk);
            const settled: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    compactionId,
                    sessionUpdate: "compaction_update",
                    status: "completed",
                },
            };
            this.#record(settled);
            await active.send(settled);
            return;
        }
        if (output.kind === "compaction-summary-blocks") {
            // Open, then settle with the summary as terminal content blocks: the
            // patch-replacement path clients must aggregate in order.
            const compactionId = `compaction-${active.turnNumber.toString()}`;
            const started: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    compactionId,
                    sessionUpdate: "compaction_update",
                    status: "in_progress",
                },
            };
            this.#record(started);
            await active.send(started);
            const settled: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    compactionId,
                    sessionUpdate: "compaction_update",
                    status: "completed",
                    summary: output.blocks.map((text) => ({ text, type: "text" })),
                },
            };
            this.#record(settled);
            await active.send(settled);
            return;
        }
        if (output.kind === "compaction") {
            // One compaction per reply turn: open, stream the summary, settle.
            const compactionId = `compaction-${active.turnNumber.toString()}`;
            const started: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    compactionId,
                    sessionUpdate: "compaction_update",
                    status: "in_progress",
                },
            };
            this.#record(started);
            await active.send(started);
            const chunk: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    compactionId,
                    content: { text: output.summary, type: "text" },
                    sessionUpdate: "compaction_summary_chunk",
                },
            };
            this.#record(chunk);
            await active.send(chunk);
            const settled: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    compactionId,
                    sessionUpdate: "compaction_update",
                    status: "completed",
                },
            };
            this.#record(settled);
            await active.send(settled);
            return;
        }
        if (output.kind === "agent-config") {
            const notification: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    configOptions: output.configOptions.map((option) => ({ ...option })),
                    sessionUpdate: "config_option_update",
                },
            };
            this.#record(notification);
            await active.send(notification);
            return;
        }
        if (output.activityType === "reasoning") {
            const notification: acp.SessionNotification = {
                sessionId: active.sessionId,
                update: {
                    content: { text: output.output, type: "text" },
                    messageId: `reasoning-${active.turnNumber.toString()}`,
                    sessionUpdate: "agent_thought_chunk",
                },
            };
            this.#record(notification);
            await active.send(notification);
            return;
        }
        const notification: acp.SessionNotification = {
            sessionId: active.sessionId,
            update: {
                kind: "other",
                name: output.title,
                rawInput: {},
                rawOutput: output.output,
                content: [...output.content],
                sessionUpdate: "tool_call",
                status: "completed",
                title: output.title,
                toolCallId: id,
            },
        };
        this.#record(notification);
        await active.send(notification);
    }

    #record(notification: acp.SessionNotification): void {
        this.#history.get(notification.sessionId)?.push(notification);
    }

    #finish(active: ActiveReply, stopReason: acp.StopReason): void {
        this.#forget(active);
        active.completion.resolve({ stopReason, _meta: { messageId: active.userMessageId } });
    }

    #forget(active: ActiveReply): void {
        if (this.#activeByPrompt.get(active.prompt) === active) {
            this.#activeByPrompt.delete(active.prompt);
        }
        if (this.#activeBySession.get(active.sessionId) === active) {
            this.#activeBySession.delete(active.sessionId);
        }
    }
}

class ControlledAgentEndpoint implements FakeHarnessEndpoint {
    readonly #closed = Promise.withResolvers<FakeHarnessEndpointTermination>();
    readonly #sessionIds = new Set<string>();
    readonly #state: ControlledAgentState;
    readonly #app: ReturnType<typeof acp.agent>;
    readonly terminated = this.#closed.promise;
    #isClosed = false;

    constructor(
        state: ControlledAgentState,
        agentName: string,
        onSessionUpdate: (notification: acp.SessionNotification) => Promise<void>,
        onPromptDelegation: (stage: PromptDelegationStage) => Promise<void>,
    ) {
        this.#state = state;
        this.#app = acp
            .agent({ name: "morty-controlled-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                _meta: { renameSession: { supported: true }, steering: { supported: true } },
                agentCapabilities: {
                    _meta: { claudeCode: { promptQueueing: true } },
                    loadSession: true,
                    promptCapabilities: { embeddedContext: true, image: true },
                    sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
                },
                agentInfo: { name: agentName, version: "controlled-harness" },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                this.#sessionIds.add(sessionId);
                this.#state.rememberSession(sessionId);
                return { configOptions: this.#state.configuration(sessionId), sessionId };
            })
            .onRequest(acp.methods.agent.session.load, async (context) => {
                this.#sessionIds.add(context.params.sessionId);
                this.#state.rememberSession(context.params.sessionId, this.#state.turnCount(context.params.sessionId));
                await this.#state.replay(context.params.sessionId, onSessionUpdate);
                return { configOptions: this.#state.configuration(context.params.sessionId) };
            })
            .onRequest(acp.methods.agent.session.fork, (context) => {
                const sessionId = this.#state.fork(context.params.sessionId);
                this.#sessionIds.add(sessionId);
                return { configOptions: this.#state.configuration(sessionId), sessionId };
            })
            .onRequest(acp.methods.agent.session.resume, (context) => {
                this.#sessionIds.add(context.params.sessionId);
                return { configOptions: this.#state.configuration(context.params.sessionId) };
            })
            .onRequest(acp.methods.agent.session.setConfigOption, (context) => ({
                configOptions: this.#state.configure(
                    context.params.sessionId,
                    context.params.configId,
                    context.params.value,
                ),
            }))
            .onRequest(acp.methods.agent.session.list, (context) => ({
                sessions: this.#state
                    .sessions()
                    .filter((session) => session.turnCount > 0)
                    .map((session) => ({
                        cwd: context.params.cwd ?? "/",
                        sessionId: session.sessionId,
                        title: this.#state.title(session.sessionId) ?? `Native ${session.sessionId}`,
                        updatedAt: "2026-01-01T00:00:00Z",
                    })),
            }))
            .onRequest(
                "_session/rename",
                (params: unknown) => params,
                (context) => {
                    const params = context.params;
                    if (
                        typeof params !== "object" ||
                        params === null ||
                        !("sessionId" in params) ||
                        typeof params.sessionId !== "string" ||
                        !("title" in params) ||
                        typeof params.title !== "string" ||
                        params.title.trim().length === 0
                    ) {
                        throw new Error("Invalid controlled Agent rename request");
                    }
                    this.#state.rename(params.sessionId, params.title);
                    return {};
                },
            )
            .onRequest(acp.methods.agent.session.prompt, async (context) => {
                return await this.#state.start(
                    context.params.sessionId,
                    context.params.prompt,
                    onSessionUpdate,
                    onPromptDelegation,
                    context.signal,
                );
            })
            .onRequest(
                "_session/steering",
                (params: unknown) => params,
                async (context) => {
                    const params = context.params;
                    if (
                        typeof params !== "object" ||
                        params === null ||
                        !("sessionId" in params) ||
                        typeof params.sessionId !== "string" ||
                        !("prompt" in params) ||
                        !Array.isArray(params.prompt)
                    ) {
                        throw new Error("Invalid controlled Agent steering request");
                    }
                    return await this.#state.steer(params.sessionId, promptText(params.prompt));
                },
            )
            .onNotification(acp.methods.agent.session.cancel, (context) => {
                this.#state.cancel(context.params.sessionId);
            })
            .onRequest(acp.methods.agent.session.close, (context) => {
                this.#state.cancel(context.params.sessionId);
                this.#sessionIds.delete(context.params.sessionId);
                return {};
            });
    }

    readonly app = () => this.#app;
    readonly initialize = async (signal: AbortSignal): Promise<void> => signal.throwIfAborted();
    readonly close = async (): Promise<void> => {
        if (this.#isClosed) {
            return;
        }
        this.#isClosed = true;
        for (const sessionId of this.#sessionIds) {
            this.#state.cancel(sessionId);
        }
        this.#sessionIds.clear();
        this.#closed.resolve({ kind: "closed" });
    };
}

export function createFakeHarness(options: FakeAgentHarnessOptions) {
    const state = new ControlledAgentState(options);
    const agents = [
        { harness: options.harness ?? "codex", name: options.agentName ?? "Codex" },
        ...(options.additionalAgents ?? []),
    ];
    return {
        agents: agents.map((agent) => ({
            createEndpoint: (
                onSessionUpdate: (notification: acp.SessionNotification) => Promise<void>,
                onPromptDelegation: (stage: PromptDelegationStage) => Promise<void>,
            ): FakeHarnessEndpoint =>
                new ControlledAgentEndpoint(state, agent.name, onSessionUpdate, onPromptDelegation),
            harness: agent.harness,
            name: agent.name,
        })),
        catalog: agents.map((agent) => ({
            agentPath: `/fake-daemon/${agent.harness}`,
            agentVersion: "controlled-harness",
            capabilities: fakeHarnessCapabilities,
            harness: agent.harness,
            label: agent.name,
        })),
        continueReply: state.continueReply,
    };
}
