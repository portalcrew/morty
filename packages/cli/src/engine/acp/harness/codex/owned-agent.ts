import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ContentBlock, PermissionOption, PromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { AgentQuestion } from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp-error.ts";
import type { NativeSessionInteractions } from "../../adapter/native-session-event.ts";
import { type AgentTermination, agentTerminationError, type BackgroundActivity } from "../../agent/agent-lifecycle.ts";
import type { CodexAppServerClient, CodexAppServerServerRequest } from "./app-server-client.ts";
import {
    commandApprovalParamsSchema,
    fileChangeApprovalParamsSchema,
    itemNotificationSchema,
    type McpElicitationParams,
    mcpElicitationParamsSchema,
    reasoningTextDeltaParamsSchema,
    requestUserInputParamsSchema,
    threadNameUpdatedSchema,
    threadNotificationSchema,
    threadSettingsUpdatedSchema,
    turnNotificationSchema,
    turnPlanUpdatedSchema,
    turnStartResponseSchema,
    turnSteerResponseSchema,
    type UserInputQuestion,
} from "./app-server-protocol.ts";
import { decodeThreadItem, messageQuestions, reasoningText, toolCallUpdate } from "./items.ts";
import type { CodexSessionAgent } from "./session-agent.ts";
import type { CodexMessageUpdate, CodexSessionUpdate } from "./session-update.ts";
import { promptResultWithMessageId } from "./session-update.ts";
import type { CodexSettings } from "./settings.ts";
import { userMessageUpdates } from "./user-message.ts";

const APPROVAL_REASON_CHARACTER_LIMIT = 500;
const APPROVAL_TIMEOUT_MILLISECONDS = 3_600_000;
// Compaction summarizes the thread with one model call; generous but finite.
const COMPACT_TIMEOUT_MILLISECONDS = 3_600_000;
// How long a manual /compact keeps its turn open for the contextCompaction item
// before ending the turn without a compaction report (older servers).
const COMPACT_ITEM_WAIT_MILLISECONDS = 600_000;

// The app-server notifications a Session handles. Every one is thread-scoped: the Codex
// app-server protocol (0.153.0 and 0.154.0) declares a required `threadId` on each, and one
// connection carries every loaded thread, including the child threads Codex runs subagents in.
// None of them is thread-agnostic, so each belongs to this Session only when it names this
// Session's thread. Notifications without a `threadId` (account, MCP server, configuration and
// deprecation warnings, fs, process and command/exec streams) and `thread/started`, which names
// its thread inside `thread`, carry nothing for a Session and are not handled.
const THREAD_NOTIFICATIONS: ReadonlySet<string> = new Set([
    "item/agentMessage/delta",
    "item/completed",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "item/started",
    "thread/compacted",
    "thread/name/updated",
    "thread/settings/updated",
    "turn/completed",
    "turn/plan/updated",
    "turn/started",
]);

interface OwnedAgentContext {
    readonly onBackgroundActivity?: (activity: BackgroundActivity) => void;
    readonly client: CodexAppServerClient;
    readonly settings: CodexSettings;
    readonly threadId: () => string;
    readonly interactions: Pick<NativeSessionInteractions, "onPermission" | "onElicitation">;
    readonly signal: AbortSignal;
    readonly emit: (update: CodexSessionUpdate) => Promise<void>;
    readonly close: () => Promise<void>;
}

/** The choices Morty offers when the app-server asks it to approve a local side effect. */
const APPROVAL_OPTIONS: readonly PermissionOption[] = Object.freeze([
    { kind: "allow_once", name: "Allow once", optionId: "accept" },
    { kind: "allow_always", name: "Allow for this session", optionId: "acceptForSession" },
    { kind: "reject_once", name: "Deny", optionId: "decline" },
]);

function permissionDecision(optionId: string): "accept" | "acceptForSession" | "decline" | "cancel" {
    if (optionId === "accept" || optionId === "acceptForSession" || optionId === "decline") {
        return optionId;
    }
    return "cancel";
}

interface SteeringPromptBlock {
    readonly content: ContentBlock;
    readonly input: unknown;
}

function steeringPrompt(prompt: readonly unknown[]): readonly SteeringPromptBlock[] {
    const blocks: SteeringPromptBlock[] = [];
    for (const block of prompt) {
        if (typeof block !== "object" || block === null) {
            throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
        }
        const type = Reflect.get(block, "type");
        if (type === "text") {
            const text = Reflect.get(block, "text");
            if (typeof text !== "string") {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            blocks.push({ content: { text, type: "text" }, input: { text, text_elements: [], type: "text" } });
            continue;
        }
        if (type === "image") {
            const data = Reflect.get(block, "data");
            const mimeType = Reflect.get(block, "mimeType");
            if (typeof data !== "string" || typeof mimeType !== "string") {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            blocks.push({
                content: { data, mimeType, type: "image" },
                input: { type: "image", url: `data:${mimeType};base64,${data}` },
            });
            continue;
        }
        if (type === "resource") {
            const resource = Reflect.get(block, "resource");
            if (typeof resource !== "object" || resource === null) {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            const uri = Reflect.get(resource, "uri");
            const text = Reflect.get(resource, "text");
            const blob = Reflect.get(resource, "blob");
            const mimeType = Reflect.get(resource, "mimeType");
            if (
                typeof uri !== "string" ||
                (typeof text !== "string" && typeof blob !== "string") ||
                (text !== undefined && typeof text !== "string") ||
                (blob !== undefined && typeof blob !== "string") ||
                (mimeType !== undefined && typeof mimeType !== "string")
            ) {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            blocks.push({
                content:
                    typeof text === "string"
                        ? {
                              resource: { text, uri, ...(typeof mimeType === "string" ? { mimeType } : {}) },
                              type: "resource",
                          }
                        : {
                              resource: { blob, uri, ...(typeof mimeType === "string" ? { mimeType } : {}) },
                              type: "resource",
                          },
                input: { text: text ?? "", text_elements: [], type: "text" },
            });
            continue;
        }
        if (type === "resource_link") {
            const name = Reflect.get(block, "name");
            const uri = Reflect.get(block, "uri");
            if (typeof name !== "string" || typeof uri !== "string") {
                throw new AcpExecutionError("Codex received an invalid steering prompt", {}, "invalid_request");
            }
            blocks.push({
                content: { name, type: "resource_link", uri },
                input: { text: `Resource: ${uri}`, text_elements: [], type: "text" },
            });
            continue;
        }
        throw new AcpExecutionError("Codex received an unsupported steering prompt", {}, "invalid_request");
    }
    return blocks;
}

interface ActiveTurn {
    readonly steeringContent: Map<string, readonly ContentBlock[]>;
    readonly clientId: string;
    readonly content: readonly ContentBlock[];
    readonly completion: PromiseWithResolvers<PromptResponse>;
    readonly turn: { id: string };
    /** The app-server reported a compaction under this turn, so whatever settled it emitted its terminal update. */
    compactionReported: boolean;
    input: { readonly kind: "awaiting" } | { readonly kind: "identified"; readonly messageId: string };
}

export function agentMessageUpdate(
    messageId: string,
    text: string,
    questions: readonly AgentQuestion[] = [],
): CodexMessageUpdate {
    // Commentary and final answers are public assistant messages; reasoning has separate events.
    return {
        content: { text, type: "text" },
        messageId,
        sessionUpdate: "agent_message_chunk",
        ...(questions.length === 0 ? {} : { _meta: { "morty.questions": questions } }),
    };
}

function userInputSchema(questions: readonly UserInputQuestion[]): unknown {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const question of questions) {
        required.push(question.id);
        properties[question.id] = {
            description: question.question,
            title: question.header,
            type: "string",
            ...(question.options == null || question.options.length === 0
                ? {}
                : {
                      oneOf: question.options.map((option) => ({
                          const: option.label,
                          description: option.description,
                          title: option.label,
                      })),
                  }),
        };
    }
    return { properties, required, type: "object" };
}

/** Owns direct turns, their live notifications, and local approval requests. */
export class CodexOwnedAcpAgent implements CodexSessionAgent {
    readonly steeringSupported = true;
    readonly runsTurns = true;
    readonly #context: OwnedAgentContext;
    readonly #appServer: CodexAppServerClient;
    readonly #settings: CodexSettings;
    readonly #streamedReasoningSources = new Map<string, "summary" | "content">();
    readonly #agentMessages = new Map<string, "started" | "streaming">();
    #turn: ActiveTurn | null = null;
    readonly #runningCommands = new Map<string, "foreground" | "background">();
    #updateTail: Promise<void> = Promise.resolve();
    // The compaction whose contextCompaction item/started has been reported but whose
    // terminal state has not. Exactly one may be open: Codex compacts sequentially,
    // and a second start cannot begin before the first settles. Cleared only through
    // #finishCompaction, which emits the terminal update — turn failure,
    // interruption, and endpoint loss all settle it so no client is left with a
    // compaction stuck in_progress.
    #openCompaction: { readonly compactionId: string } | null = null;
    // Set when the turn machinery (turn/completed or cancel) settled this turn's
    // compaction, so the compact error path does not report a second terminal
    // update for the same failure.

    constructor(context: OwnedAgentContext) {
        this.#context = context;
        this.#appServer = context.client;
        this.#settings = context.settings;
    }

    readonly onTerminated = (termination: AgentTermination): void => {
        if (this.#turn !== null) {
            this.#turn.steeringContent.clear();
        }
        this.#turn?.completion.reject(agentTerminationError(termination));
        this.#settleCompaction("cancelled");
    };
    readonly close = async (): Promise<void> => {
        if (this.#turn !== null) {
            this.#turn.steeringContent.clear();
        }
        this.#turn?.completion.reject(new AcpExecutionError("The Codex endpoint is closed", {}, "acp_endpoint_closed"));
        this.#settleCompaction("cancelled");
    };

    /** Emits the terminal compaction update for the open compaction, if any, and
     *  wakes a manual /compact waiting on it. A terminal update may patch an
     *  already-terminal entity (the app-server can race an item/completed past a
     *  cancellation), which clients merge idempotently. The wake rides the enqueued
     *  emission so the waiting prompt's response never precedes the update. */
    readonly #settleCompaction = (
        status: "cancelled" | "completed" | "failed",
        error?: string,
    ): { readonly compactionId: string } | null => {
        const open = this.#openCompaction;
        if (open === null) {
            return null;
        }
        const update: CodexSessionUpdate = {
            compactionId: open.compactionId,
            ...(status === "failed" && error !== undefined ? { error } : {}),
            sessionUpdate: "compaction_update",
            status,
        };
        this.#finishCompaction(async () => {
            await this.#context.emit(update);
        });
        return open;
    };

    /** Clears the tracked compaction and emits the terminal update. Used by both
     *  #settleCompaction and the item/completed handler, which emits its own
     *  terminal update. */
    readonly #finishCompaction = (emit: () => Promise<void>): void => {
        this.#openCompaction = null;
        void this.#enqueue(emit).catch((cause: unknown) => {
            console.error("The Codex compaction settlement could not be delivered", cause);
        });
    };

    /** Manual /compact: drives thread/compact/start, which the app-server executes
     *  as its own turn. The turn is registered like a prompt's so every terminal
     *  path is owned: turn/completed(failed) settles the open compaction as failed
     *  and rejects, turn/completed(interrupted) and Stop settle it as cancelled,
     *  and endpoint loss settles it through onTerminated. The contextCompaction
     *  item the server streams is the lifecycle clients see — started/completed
     *  under the item's id — and its completed resolves the wait. A bounded wait
     *  guards servers that accept the compact but never report a result; expiry is
     *  a failure, never a success. */
    readonly compact = async (signal: AbortSignal): Promise<PromptResponse> => {
        signal.throwIfAborted();
        if (this.#turn !== null) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        if (this.#openCompaction !== null) {
            throw new AcpExecutionError(
                "Another compaction is already running in this conversation",
                {},
                "session_busy",
            );
        }
        const completion = Promise.withResolvers<PromptResponse>();
        // A failure can arrive before thread/compact/start responds.
        void completion.promise.catch(() => {});
        const aborted = (): void => {
            completion.reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        // The bounded wait is owned by this call and cancelled in the finally below:
        // a lost delay() timer stays ref'ed and would keep the worker's event loop
        // alive for the whole window after the compaction already settled.
        const waitExpired = new AbortController();
        // Armed before the RPC is sent: a short compaction can complete before its
        // own response arrives, and a completion for an unarmed turn would be lost.
        const turn: ActiveTurn = {
            completion,
            content: [],
            steeringContent: new Map(),
            clientId: randomUUID(),
            input: { kind: "awaiting" },
            compactionReported: false,
            turn: { id: "" },
        };
        this.#turn = turn;
        try {
            await this.#appServer.request(
                "thread/compact/start",
                { threadId: this.#context.threadId() },
                AbortSignal.any([signal, AbortSignal.timeout(COMPACT_TIMEOUT_MILLISECONDS)]),
            );
            return await Promise.race([
                completion.promise,
                delay(COMPACT_ITEM_WAIT_MILLISECONDS, undefined, { signal: waitExpired.signal }).then(() => {
                    throw new AcpExecutionError(
                        "The Codex compaction did not report a result",
                        {},
                        "codex_compaction_unreported",
                    );
                }),
            ]);
        } catch (cause: unknown) {
            signal.throwIfAborted();
            // Close whatever the client saw open. The turn machinery settles the
            // tracked compaction on failure, so a null here may mean "already
            // settled" — a terminal update has been emitted under the item id and
            // nothing more may be reported. Only a compaction that never opened
            // (the start RPC itself failed; no item streamed, nothing emitted) gets
            // a fresh-id failed update here.
            const open = this.#settleCompaction("failed", cause instanceof Error ? cause.message : String(cause));
            if (open === null && !turn.compactionReported) {
                const compactionId = randomUUID();
                await this.#enqueue(async () => {
                    await this.#context.emit({
                        compactionId,
                        error: cause instanceof Error ? cause.message : String(cause),
                        sessionUpdate: "compaction_update",
                        status: "failed",
                    });
                });
            }
            throw cause;
        } finally {
            signal.removeEventListener("abort", aborted);
            waitExpired.abort();
            if (this.#turn === turn) {
                this.#turn = null;
            }
        }
    };

    /** Pushes the current settings so a mode change Codex applied reaches the Run settings panel. */
    readonly #emitConfigOptionsUpdate = async (): Promise<void> => {
        await this.#context.emit({
            configOptions: this.#settings.configOptions(),
            sessionUpdate: "config_option_update",
        });
    };

    // Notifications are serialized so two app-server items cannot interleave into one ACP update
    // stream, and the caller awaits the result: `turn/completed` must not resolve the prompt before
    // the updates it precedes have reached the client.
    readonly #enqueue = async (operation: () => Promise<void>): Promise<void> => {
        const pending = this.#updateTail.then(operation, operation);
        this.#updateTail = pending;
        await pending;
    };

    readonly onNotification = async (method: string, params: unknown): Promise<void> => {
        if (!THREAD_NOTIFICATIONS.has(method)) {
            return;
        }
        // Thread ownership is decided here, once, before any branch reads or mutates Session state:
        // a notification for another thread, such as a subagent's child thread, or one without a
        // valid thread identity never reaches this Session's tracking or output.
        const thread = threadNotificationSchema.safeParse(params);
        if (!thread.success || thread.data.threadId !== this.#context.threadId()) {
            return;
        }
        if (method === "turn/started") {
            const decoded = turnNotificationSchema.safeParse(params);
            if (
                decoded.success &&
                this.#turn !== null &&
                (this.#turn.turn.id === "" || this.#turn.turn.id === decoded.data.turn.id)
            ) {
                this.#turn.turn.id = decoded.data.turn.id;
            }
            return;
        }
        if (method === "turn/completed") {
            const decoded = turnNotificationSchema.safeParse(params);
            if (decoded.success) {
                await this.#enqueue(async () => {
                    for (const [id, mode] of this.#runningCommands) {
                        if (mode === "background") {
                            continue;
                        }
                        this.#runningCommands.set(id, "background");
                        await this.#context.emit({
                            sessionUpdate: "tool_call_update",
                            toolCallId: id,
                            _meta: { "morty.backgroundTask": { id, status: "running" } },
                        });
                    }
                });
                await this.#completeTurn(decoded.data.turn);
            }
            return;
        }
        if (method === "thread/name/updated") {
            const decoded = threadNameUpdatedSchema.safeParse(params);
            if (decoded.success) {
                const title = decoded.data.threadName;
                await this.#enqueue(async () => {
                    await this.#context.emit({ sessionUpdate: "session_info_update", title });
                });
            }
            return;
        }
        if (method === "thread/compacted") {
            // Older app-servers report compaction through this notification instead
            // of a contextCompaction item. It may only settle a compaction that
            // already opened (item/started tracked it): with nothing open there is
            // no entity to patch, and emitting a completed under a fabricated id
            // would report a compaction the client never saw open — the same
            // discipline as the pi adapter's unopened auto_compaction_end.
            this.#settleCompaction("completed");
            return;
        }
        if (method === "thread/settings/updated") {
            const decoded = threadSettingsUpdatedSchema.safeParse(params);
            if (decoded.success) {
                const mode = decoded.data.threadSettings.collaborationMode?.mode;
                if (this.#settings.observeCollaborationMode(mode)) {
                    await this.#enqueue(async () => {
                        await this.#emitConfigOptionsUpdate();
                    });
                }
            }
            return;
        }
        if (method === "turn/plan/updated") {
            const decoded = turnPlanUpdatedSchema.safeParse(params);
            if (decoded.success) {
                const entries = decoded.data.plan.map((step) => ({
                    content:
                        typeof step === "object" && step !== null && "step" in step
                            ? String(Reflect.get(step, "step"))
                            : "",
                    priority: "medium" as const,
                    status: "in_progress" as const,
                }));
                await this.#enqueue(async () => {
                    await this.#context.emit({ entries, sessionUpdate: "plan" });
                });
            }
            return;
        }
        if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
            const decoded = reasoningTextDeltaParamsSchema.safeParse(params);
            if (
                decoded.success &&
                this.#turn !== null &&
                decoded.data.turnId === this.#turn.turn.id &&
                decoded.data.delta.length > 0
            ) {
                const source = method === "item/reasoning/textDelta" ? "content" : "summary";
                const previous = this.#streamedReasoningSources.get(decoded.data.itemId);
                this.#streamedReasoningSources.set(
                    decoded.data.itemId,
                    previous === "content" || source === "content" ? "content" : "summary",
                );
                await this.#enqueue(async () => {
                    await this.#context.emit({
                        content: { text: decoded.data.delta, type: "text" },
                        messageId: decoded.data.itemId,
                        sessionUpdate: "agent_thought_chunk",
                    });
                });
            }
            return;
        }
        if (method === "item/agentMessage/delta") {
            const decoded = reasoningTextDeltaParamsSchema.safeParse(params);
            if (
                decoded.success &&
                this.#turn !== null &&
                decoded.data.turnId === this.#turn.turn.id &&
                decoded.data.delta.length > 0
            ) {
                this.#agentMessages.set(decoded.data.itemId, "streaming");
                await this.#enqueue(async () => {
                    await this.#context.emit(agentMessageUpdate(decoded.data.itemId, decoded.data.delta));
                });
            }
            return;
        }
        if (method !== "item/started" && method !== "item/completed") {
            return;
        }
        const notification = itemNotificationSchema.safeParse(params);
        const item = notification.success ? decodeThreadItem(notification.data.item) : null;
        if (item === null) {
            return;
        }
        if (item.type === "userMessage") {
            if (method === "item/started") {
                const turn = this.#turn;
                if (
                    turn === null ||
                    typeof params !== "object" ||
                    params === null ||
                    Reflect.get(params, "turnId") !== turn.turn.id
                ) {
                    return;
                }
                const submitted =
                    item.clientId === turn.clientId
                        ? turn.content
                        : item.clientId == null
                          ? undefined
                          : turn.steeringContent.get(item.clientId);
                if (item.clientId != null) {
                    turn.steeringContent.delete(item.clientId);
                }
                if (item.clientId === turn.clientId && turn.input.kind === "awaiting") {
                    turn.input = { kind: "identified", messageId: item.id };
                }
                await this.#enqueue(async () => {
                    for (const update of userMessageUpdates(item, submitted)) {
                        await this.#context.emit(update);
                    }
                });
            }
            return;
        }
        if (item.type === "agentMessage" || item.type === "plan") {
            // An item/completed agent message carries the whole text and would duplicate the deltas
            // already streamed for the same item. Plans use only the completed item's canonical
            // body: item/plan/delta text can differ and ACP message chunks are append-only.
            if (method === "item/started") {
                this.#agentMessages.set(item.id, "started");
                return;
            }
            const message = this.#agentMessages.get(item.id);
            this.#agentMessages.delete(item.id);
            if (message === "streaming") {
                return;
            }
            await this.#enqueue(async () => {
                await this.#context.emit(agentMessageUpdate(item.id, item.text, messageQuestions(item)));
            });
            return;
        }
        if (item.type === "contextCompaction") {
            // The item id doubles as the ACP compaction id: started opens the
            // compaction, completed settles it. Codex exposes no streamed summary,
            // so no compaction_summary_chunk follows. Both automatic compactions
            // and manual /compact surface here exactly once; the open id is tracked
            // so failure, interruption, or endpoint loss can settle it.
            if (method === "item/started") {
                this.#openCompaction = { compactionId: item.id };
                if (this.#turn !== null) {
                    this.#turn.compactionReported = true;
                }
            }
            if (method === "item/completed") {
                // The item's own terminal update is the settlement; #finishCompaction
                // clears the tracked state and wakes the waiter after it drains.
                this.#finishCompaction(async () => {
                    await this.#context.emit({
                        compactionId: item.id,
                        sessionUpdate: "compaction_update",
                        status: "completed",
                    });
                });
                return;
            }
            await this.#enqueue(async () => {
                await this.#context.emit({
                    compactionId: item.id,
                    sessionUpdate: "compaction_update",
                    status: "in_progress",
                });
            });
            return;
        }
        const reasoning = reasoningText(item);
        if (reasoning !== null) {
            const streamedSource =
                method === "item/completed" ? this.#streamedReasoningSources.get(item.id) : undefined;
            if (method === "item/completed") {
                this.#streamedReasoningSources.delete(item.id);
            }
            const needsCompletedContent =
                method === "item/completed" &&
                reasoning.length > 0 &&
                (streamedSource === undefined ||
                    (streamedSource === "summary" && item.type === "reasoning" && item.content.length > 0));
            if (needsCompletedContent) {
                await this.#enqueue(async () => {
                    await this.#context.emit({
                        content: { text: reasoning, type: "text" },
                        messageId: item.id,
                        sessionUpdate: "agent_thought_chunk",
                    });
                });
            }
            return;
        }
        const update = toolCallUpdate(item, method === "item/completed" ? "completed" : "started");
        if (update !== null) {
            await this.#enqueue(async () => {
                if (item.type === "commandExecution" && method === "item/started") {
                    this.#runningCommands.set(item.id, "foreground");
                    this.#context.onBackgroundActivity?.("running");
                }
                if (method === "item/started") {
                    await this.#context.emit({ ...update, sessionUpdate: "tool_call" });
                } else {
                    await this.#context.emit({
                        ...update,
                        sessionUpdate: "tool_call_update",
                        ...(this.#runningCommands.get(item.id) === "background"
                            ? {
                                  _meta: {
                                      ...update._meta,
                                      "morty.backgroundTask": {
                                          id: item.id,
                                          status: update.status === "completed" ? "completed" : "failed",
                                      },
                                  },
                              }
                            : {}),
                    });
                }
                if (item.type === "commandExecution" && method === "item/completed") {
                    this.#runningCommands.delete(item.id);
                    this.#context.onBackgroundActivity?.(this.#runningCommands.size > 0 ? "running" : "none");
                }
            });
        }
    };

    readonly onServerRequest = async (request: CodexAppServerServerRequest): Promise<void> => {
        if (
            request.method === "item/commandExecution/requestApproval" ||
            request.method === "item/fileChange/requestApproval"
        ) {
            await this.#requestApproval(request);
            return;
        }
        if (request.method === "item/tool/requestUserInput") {
            await this.#requestUserInput(request);
            return;
        }
        if (request.method === "mcpServer/elicitation/request") {
            await this.#requestMcpElicitation(request);
            return;
        }
        // Morty did not opt into these capabilities. Answering an error keeps the conversation
        // honest instead of letting the app-server wait on a request nobody will handle.
        this.#appServer.respondWithError(request.id, -32_601, `Morty does not support ${request.method}`);
    };

    readonly #askPermission = async (
        title: string,
        toolCallId: string,
        signal: AbortSignal,
    ): Promise<"accept" | "acceptForSession" | "decline" | "cancel"> => {
        const response = await this.#context.interactions.onPermission(
            {
                options: [...APPROVAL_OPTIONS],
                sessionId: this.#context.threadId(),
                toolCall: { title, toolCallId },
            },
            AbortSignal.any([signal, this.#context.signal]),
        );
        return response.outcome.outcome === "selected" ? permissionDecision(response.outcome.optionId) : "cancel";
    };

    readonly #requestApproval = async (request: CodexAppServerServerRequest): Promise<void> => {
        const decoded =
            request.method === "item/commandExecution/requestApproval"
                ? commandApprovalParamsSchema.safeParse(request.params)
                : fileChangeApprovalParamsSchema.safeParse(request.params);
        if (!decoded.success) {
            this.#appServer.respondWithError(request.id, -32_602, "Morty could not read the approval request");
            return;
        }
        const params = decoded.data;
        const command = "command" in params ? params.command : undefined;
        const title = (command ?? params.reason ?? "Approve a local change").slice(0, APPROVAL_REASON_CHARACTER_LIMIT);
        const turn = this.#turn;
        const decision = await this.#askPermission(
            title,
            params.itemId,
            AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS),
        );
        void turn;
        this.#appServer.respond(request.id, { decision });
    };

    readonly #requestUserInput = async (request: CodexAppServerServerRequest): Promise<void> => {
        const decoded = requestUserInputParamsSchema.safeParse(request.params);
        if (!decoded.success) {
            this.#appServer.respond(request.id, { answers: {} });
            return;
        }
        const questions = decoded.data.questions;
        const response = await this.#context.interactions.onElicitation(
            {
                message: questions
                    .map((question) => question.question)
                    .join("\n\n")
                    .slice(0, 2_000),
                mode: "form",
                requestedSchema: userInputSchema(questions),
                sessionId: this.#context.threadId(),
                ...(decoded.data.itemId == null ? {} : { toolCallId: decoded.data.itemId }),
            },
            AbortSignal.any([this.#context.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]),
        );
        const content = response.action === "accept" ? Reflect.get(response, "content") : undefined;
        const answers: Record<string, unknown> = {};
        for (const question of questions) {
            const value =
                typeof content === "object" && content !== null ? Reflect.get(content, question.id) : undefined;
            answers[question.id] = { answers: typeof value === "string" && value.length > 0 ? [value] : [] };
        }
        this.#appServer.respond(request.id, { answers });
    };

    readonly #requestMcpElicitation = async (request: CodexAppServerServerRequest): Promise<void> => {
        const decoded = mcpElicitationParamsSchema.safeParse(request.params);
        if (!decoded.success) {
            this.#appServer.respondWithError(request.id, -32_602, "Morty could not read the elicitation request");
            return;
        }
        const params: McpElicitationParams = decoded.data;
        const signal = AbortSignal.any([this.#context.signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]);
        if (params.mode === "url" && params.url !== undefined) {
            const response = await this.#context.interactions.onElicitation(
                {
                    elicitationId: `${this.#context.threadId()}-${String(request.id)}`,
                    message: params.message,
                    mode: "url",
                    sessionId: this.#context.threadId(),
                    url: params.url,
                },
                signal,
            );
            this.#appServer.respond(request.id, { action: response.action });
            return;
        }
        const response = await this.#context.interactions.onElicitation(
            {
                message: params.message,
                mode: "form",
                requestedSchema: params.requestedSchema ?? { properties: {}, required: [], type: "object" },
                sessionId: this.#context.threadId(),
            },
            signal,
        );
        const content = response.action === "accept" ? (Reflect.get(response, "content") ?? null) : null;
        this.#appServer.respond(request.id, { action: response.action, content });
    };

    readonly prompt = async (
        input: readonly unknown[],
        signal: AbortSignal,
        content: readonly ContentBlock[],
    ): Promise<PromptResponse> => {
        signal.throwIfAborted();
        if (this.#turn !== null) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        const completion = Promise.withResolvers<PromptResponse>();
        // A failure can arrive before turn/start responds. Its rejection is awaited below,
        // but must already be handled while that RPC is still pending.
        void completion.promise.catch(() => {});
        const aborted = (): void => {
            completion.reject(signal.reason);
            void this.#context.close().catch((cause: unknown) => {
                console.error("The cancelled Codex endpoint could not release its process tree", cause);
            });
        };
        signal.addEventListener("abort", aborted, { once: true });
        // The turn is armed before `turn/start` is sent: a short turn can complete before its own
        // response arrives, and a completion for an unarmed turn would be lost.
        const turn: ActiveTurn = {
            completion,
            content,
            steeringContent: new Map(),
            clientId: randomUUID(),
            input: { kind: "awaiting" },
            compactionReported: false,
            turn: { id: "" },
        };
        this.#agentMessages.clear();
        this.#streamedReasoningSources.clear();
        this.#turn = turn;
        try {
            // The selection rides on the turn rather than the thread, so a choice made between turns
            // applies to the next one without restarting the conversation. Approval and sandboxing
            // travel as a pair: Codex resolves them together into the mode's single preset.
            const { turn: started } = turnStartResponseSchema.parse(
                await this.#appServer.request(
                    "turn/start",
                    {
                        ...this.#settings.turnParameters(),
                        input,
                        clientUserMessageId: turn.clientId,
                        threadId: this.#context.threadId(),
                    },
                    signal,
                ),
            );
            if (this.#turn === turn) {
                turn.turn.id = started.id;
            }
            try {
                const result = await completion.promise;
                return turn.input.kind === "identified"
                    ? await promptResultWithMessageId(Promise.resolve(result), turn.input.messageId)
                    : result;
            } catch (cause) {
                if (turn.input.kind === "identified" && !signal.aborted) {
                    return await promptResultWithMessageId(Promise.reject(cause), turn.input.messageId);
                }
                throw cause;
            }
        } finally {
            signal.removeEventListener("abort", aborted);
            if (this.#turn === turn) {
                turn.steeringContent.clear();
                this.#turn = null;
                this.#agentMessages.clear();
                this.#streamedReasoningSources.clear();
            }
        }
    };

    readonly steer = async (
        params: unknown,
        signal: AbortSignal,
    ): Promise<{ readonly outcome: "injected" } | { readonly outcome: "promptRequired"; readonly reason: string }> => {
        if (typeof params !== "object" || params === null) {
            throw new AcpExecutionError("Codex received an invalid steering request", {}, "invalid_request");
        }
        const sessionId = Reflect.get(params, "sessionId");
        const prompt = Reflect.get(params, "prompt");
        if (typeof sessionId !== "string" || !Array.isArray(prompt)) {
            throw new AcpExecutionError("Codex received an invalid steering request", {}, "invalid_request");
        }
        const active = this.#turn;
        if (sessionId !== this.#context.threadId() || active === null || active.turn.id.length === 0) {
            return { outcome: "promptRequired", reason: "noRunningTurn" };
        }
        const steering = steeringPrompt(prompt);
        if (steering.length === 0) {
            throw new AcpExecutionError("Codex received an empty steering request", {}, "invalid_request");
        }
        if (active.steeringContent.size >= 100) {
            throw new AcpExecutionError("Too many steering requests are pending consumption", {}, "session_busy");
        }
        const submitted = steering.map((block) => block.content);
        const clientId = randomUUID();
        active.steeringContent.set(clientId, submitted);
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS)]);
        try {
            const response = turnSteerResponseSchema.parse(
                await this.#appServer.request(
                    "turn/steer",
                    {
                        expectedTurnId: active.turn.id,
                        clientUserMessageId: clientId,
                        input: steering.map((block) => block.input),
                        threadId: this.#context.threadId(),
                    },
                    bounded,
                ),
            );
            if (response.turnId !== active.turn.id) {
                throw new AcpExecutionError("Codex steered an unexpected turn", {}, "steering_target_unavailable");
            }
            // Native acceptance owns the input. Its user item and identity may arrive much later.
            return { outcome: "injected" };
        } catch (cause) {
            active.steeringContent.delete(clientId);
            throw cause;
        }
    };

    readonly cancel = async (): Promise<void> => {
        const turn = this.#turn;
        if (turn === null) {
            return;
        }
        this.#turn = null;
        turn.steeringContent.clear();
        if (turn.turn.id.length > 0) {
            try {
                await this.#appServer.request(
                    "turn/interrupt",
                    { threadId: this.#context.threadId(), turnId: turn.turn.id },
                    AbortSignal.timeout(APPROVAL_TIMEOUT_MILLISECONDS),
                );
            } catch {
                // Turn completion below remains authoritative.
            }
        }
        // The interrupted turn's terminal notification may never arrive; its open
        // compaction must not outlive it.
        this.#settleCompaction("cancelled");
        turn.completion.resolve({ stopReason: "cancelled" });
    };

    readonly #completeTurn = async (turn: {
        readonly error?: { readonly message: string } | null | undefined;
        readonly id: string;
        readonly status: string;
    }): Promise<void> => {
        const active = this.#turn;
        if (active === null || active.turn.id !== turn.id) {
            return;
        }
        active.steeringContent.clear();
        // Keep this Turn reachable by termination and cancellation until its output has drained.
        // The app-server dispatches notifications concurrently, so an item update can still be in
        // flight when the turn completes. Drain it: a client must never see the turn finish before
        // the activity that belongs to it.
        await this.#updateTail;
        if (turn.status === "failed") {
            // The app-server reports a failed turn's compaction as never-completed:
            // settle the open compaction under the same failure before the turn
            // rejects, so the client is not left with a compaction stuck in_progress.
            this.#settleCompaction("failed", turn.error?.message ?? "The Codex turn failed");
            active.completion.reject(
                new AcpExecutionError(turn.error?.message ?? "The Codex turn failed", {}, "codex_turn_failed"),
            );
            return;
        }
        if (turn.status === "interrupted") {
            this.#settleCompaction("cancelled");
            active.completion.resolve({ stopReason: "cancelled" });
            return;
        }
        active.completion.resolve({ stopReason: "end_turn" });
    };
}
