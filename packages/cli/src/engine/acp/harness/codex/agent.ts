import { randomUUID } from "node:crypto";
import {
    type ContentBlock,
    PROTOCOL_VERSION,
    type PromptRequest,
    type PromptResponse,
} from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";
import { captureProcessTree, type ProcessTreeIdentity, stopProcessTree } from "../../../util/process/executable.ts";
import { agentTerminationError } from "../../agent/agent-lifecycle.ts";
import { CodexAppServerClient } from "./app-server-client.ts";
import {
    threadForkResponseSchema,
    threadListResponseSchema,
    threadResumeResponseSchema,
    threadStartResponseSchema,
} from "./app-server-protocol.ts";
import { CodexBorrowedAcpAgent } from "./borrowed-agent.ts";
import { replayCodexHistory } from "./history.ts";
import { CodexOwnedAcpAgent } from "./owned-agent.ts";
import type { CodexSessionAgent } from "./session-agent.ts";
import { type CodexClientOptions, type CodexSessionUpdate, promptResultWithMessageId } from "./session-update.ts";
import { CodexSettings } from "./settings.ts";

const APPROVAL_TIMEOUT_MILLISECONDS = 3_600_000;
const CODEX_AGENT_VERSION = "0.154.0";

function promptInput(prompt: readonly ContentBlock[]): readonly unknown[] {
    return prompt.flatMap((block): unknown[] => {
        switch (block.type) {
            case "text":
                return [{ text: block.text, text_elements: [], type: "text" }];
            case "image":
                return [{ type: "image", url: `data:${block.mimeType};base64,${block.data}` }];
            case "resource":
                return [
                    {
                        text: "text" in block.resource ? block.resource.text : "",
                        text_elements: [],
                        type: "text",
                    },
                ];
            case "resource_link":
                return [{ text: `Resource: ${block.uri}`, text_elements: [], type: "text" }];
            default:
                return [];
        }
    });
}

/** One native app-server client. Shared harness ownership supplies the Morty session lifecycle. */
export class CodexAcpAgent {
    readonly #appServer: CodexAppServerClient;
    readonly #lifetime = new AbortController();
    readonly signal = this.#lifetime.signal;
    readonly #options: CodexClientOptions;
    readonly #settings: CodexSettings;
    #closePromise: Promise<void> | null = null;
    #sessionId = "";
    #sessionAgent: CodexSessionAgent;

    constructor(options: CodexClientOptions) {
        this.#options = options;
        this.#appServer = new CodexAppServerClient({
            command: options.command,
            cwd: options.cwd,
            environment: options.environment,
            handlers: {
                onNotification: async (method, params) => await this.#sessionAgent.onNotification(method, params),
                onServerRequest: async (request) => await this.#sessionAgent.onServerRequest(request),
            },
        });
        this.#settings = new CodexSettings(this.#appServer);
        this.#sessionAgent = new CodexOwnedAcpAgent({
            client: this.#appServer,
            settings: this.#settings,
            threadId: () => this.#sessionId,
            interactions: options.interactions,
            signal: this.signal,
            emit: this.#emit,
            onBackgroundActivity: (activity) => {
                if (this.#closePromise === null) {
                    options.onBackgroundActivity?.(activity);
                }
            },
            close: () => this.dispose("force"),
        });
        void this.#appServer.terminated.then((termination) => {
            this.#sessionAgent.onTerminated(termination);
            this.#lifetime.abort(agentTerminationError(termination));
            if (termination.kind === "failed") {
                void this.dispose("force").catch((cause: unknown) => {
                    console.error("The failed Codex client could not release its process tree", cause);
                });
            }
        });
    }

    static readonly capabilities = () => ({
        _meta: { steering: { supported: true } },
        agentCapabilities: {
            loadSession: true,
            promptCapabilities: { embeddedContext: true, image: true },
            sessionCapabilities: { close: {}, fork: {}, list: {} },
        },
        agentInfo: { name: "Codex", version: CODEX_AGENT_VERSION },
        authMethods: [],
        protocolVersion: PROTOCOL_VERSION,
    });
    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        await this.#appServer.initialize(signal);
        await this.#settings.loadModels(signal);
        this.signal.throwIfAborted();
    };
    readonly runsTurns = (): boolean => this.#sessionAgent.runsTurns;
    readonly agentSettingsModelEffort = () => this.#settings.agentModelEffort();
    readonly sessionConfiguration = () => ({ configOptions: this.#settings.configOptions() });
    readonly sessionState = () => ({
        sessionId: this.#sessionId,
        configOptions: this.#settings.configOptions(),
        _meta: {
            steering: { supported: this.#sessionAgent.steeringSupported },
            codex: { runsTurns: this.#sessionAgent.runsTurns },
        },
    });
    readonly setSessionConfigOption = (request: {
        readonly configId: string;
        readonly value: string | boolean;
    }): void => {
        this.#settings.applySelection(request.configId, request.value);
    };
    readonly setSessionMode = (request: { readonly modeId: string }): void => {
        this.#settings.applySelection("mode", request.modeId);
    };
    readonly #opened = async () => {
        await this.#emit({
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "compact", description: "Manually compact the session context" }],
        });
        return this.sessionState();
    };
    readonly newSession = async (request: { readonly cwd: string }, signal: AbortSignal) => {
        // Codex retains authority over its own sandbox and approval settings.
        const created = threadStartResponseSchema.parse(
            await this.#appServer.request(
                "thread/start",
                { cwd: request.cwd },
                AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
            ),
        );
        this.#sessionId = created.thread.id;
        this.#settings.selectNewThread(created);
        await this.#settings.probeCollaborationMode(this.#sessionId, signal);
        return await this.#opened();
    };
    readonly forkSession = async (
        request: { readonly cwd: string; readonly sessionId: string },
        signal: AbortSignal,
    ) => {
        const forked = threadForkResponseSchema.parse(
            await this.#appServer.request(
                "thread/fork",
                {
                    cwd: request.cwd,
                    excludeTurns: true,
                    threadId: request.sessionId,
                },
                AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
            ),
        );
        this.#sessionId = forked.thread.id;
        this.#settings.selectRestoredThread(forked);
        await this.#settings.probeCollaborationMode(this.#sessionId, signal);
        return await this.#opened();
    };
    readonly resumeSession = async (
        request: { readonly cwd: string; readonly sessionId: string },
        signal: AbortSignal,
    ) => {
        await this.#resume(request.sessionId, request.cwd, signal);
        return await this.#opened();
    };
    readonly loadSession = async (
        request: { readonly cwd: string; readonly sessionId: string },
        signal: AbortSignal,
    ) => {
        await this.#resume(request.sessionId, request.cwd, signal);
        await this.readHistory(request.sessionId, signal);
        return await this.#opened();
    };
    /** Read-only history never resumes the source thread or acquires its writer lock. */
    readonly readHistory = async (sessionId: string, signal: AbortSignal): Promise<void> => {
        this.#sessionId = sessionId;
        await replayCodexHistory(this.#appServer, sessionId, this.#emit, signal);
    };
    readonly listSessions = async (cursor: string | null, signal: AbortSignal) => {
        const decoded = threadListResponseSchema.parse(
            await this.#appServer.request(
                "thread/list",
                {
                    cursor,
                    sourceKinds: ["cli", "vscode", "exec", "appServer"],
                    useStateDbOnly: true,
                },
                AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            ),
        );
        return {
            nextCursor: decoded.nextCursor ?? null,
            sessions: decoded.data.map((thread) => ({
                cwd: thread.cwd,
                sessionId: thread.id,
                title: thread.name ?? thread.preview ?? null,
                updatedAt: new Date(thread.updatedAt * 1_000).toISOString(),
            })),
        };
    };
    readonly prompt = async (request: PromptRequest): Promise<PromptResponse> => {
        const prompt = request.prompt;
        if (prompt.length === 1 && prompt[0]?.type === "text" && prompt[0].text.trim().toLowerCase() === "/compact") {
            const messageId = randomUUID();
            for (const content of prompt) {
                await this.#emit({ sessionUpdate: "user_message_chunk", messageId, content });
            }
            return await promptResultWithMessageId(this.#sessionAgent.compact(this.signal), messageId);
        }
        return await this.#sessionAgent.prompt(promptInput(prompt), this.signal, prompt);
    };
    readonly steer = async (request: unknown, signal: AbortSignal) => await this.#sessionAgent.steer(request, signal);
    readonly cancel = async (_request: { readonly sessionId: string }): Promise<void> => {
        if (this.#sessionAgent.runsTurns) {
            // Interrupt alone leaves unified-exec tools alive, including late startup notifications.
            await this.dispose("force");
        } else {
            await this.#sessionAgent.cancel();
        }
    };
    readonly dispose = (_mode: "graceful" | "force"): Promise<void> => {
        if (this.#closePromise === null) {
            this.#closePromise = (async () => {
                try {
                    // Withdraw borrowed input before disconnecting from its owner, even on forced retirement.
                    await this.#sessionAgent.close();
                } finally {
                    this.#appServer.detach();
                    const child = this.#appServer.child();
                    try {
                        const captured: readonly ProcessTreeIdentity[] = await captureProcessTree(child);
                        await stopProcessTree(child, captured);
                    } finally {
                        this.#lifetime.abort(new DOMException("The Codex client closed", "AbortError"));
                        this.#options.onBackgroundActivity?.("none");
                    }
                }
            })();
        }
        return this.#closePromise;
    };
    readonly #resume = async (threadId: string, cwd: string, signal: AbortSignal): Promise<void> => {
        const resumed = await (async () => {
            try {
                return threadResumeResponseSchema.parse(
                    await this.#appServer.request(
                        "thread/resume",
                        { cwd, excludeTurns: true, threadId },
                        AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
            } catch (cause: unknown) {
                signal.throwIfAborted();
                console.warn("Codex thread resume failed; attempting borrowed queue access", { threadId }, cause);
                return null;
            }
        })();
        if (resumed === null) {
            const saved = z
                .object({
                    thread: z.object({
                        id: z.literal(threadId),
                        model: z.string().nullish(),
                        reasoningEffort: z.string().nullish(),
                        turns: z.array(z.unknown()),
                    }),
                })
                .parse(
                    await this.#appServer.request(
                        "thread/read",
                        { threadId, includeTurns: false },
                        AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
                    ),
                );
            const queued = new CodexBorrowedAcpAgent(
                this.#appServer,
                threadId,
                this.#emit,
                async (stage) => await this.#options.onPromptDelegation?.(stage),
            );
            await queued.initialize(signal);
            this.#sessionId = threadId;
            this.#settings.selectRestoredThread({
                thread: { id: threadId },
                model: saved.thread.model,
                reasoningEffort: saved.thread.reasoningEffort,
            });
            await this.#sessionAgent.close();
            this.#sessionAgent = queued;
            return;
        }
        this.#sessionId = resumed.thread.id;
        this.#settings.selectRestoredThread(resumed);
        await this.#settings.probeCollaborationMode(this.#sessionId, signal);
    };
    readonly #emit = async (update: CodexSessionUpdate): Promise<void> => {
        if (this.#sessionId.length > 0) {
            await this.#options.onSessionUpdate({ sessionId: this.#sessionId, update });
        }
    };
}
