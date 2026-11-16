import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type {
    ContentBlock,
    McpServer,
    ToolCallContent,
    ToolCallLocation,
    ToolKind,
} from "@agentclientprotocol/sdk/unstable";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";
import {
    type PiProcessHost,
    type PiRpcEvent,
    PiRpcProcess,
    PiRpcProcessError,
    PiRpcSpawnError,
    type PiSessionOrigin,
    type PiSessionStats,
    SESSION_STATS_TIMEOUT_MS,
} from "../pi-rpc/process.js";
import { maybeAuthRequiredError } from "./auth-required.js";
import type { PiAcpClient } from "./client.js";
import { PiExtensionQuestions } from "./extension-questions.js";
import { SessionStore } from "./session-store.js";
import type { PiSessionUpdate } from "./session-update.js";
import { expandSlashCommand, type FileSlashCommand } from "./slash-commands.js";
import { bashCommand, bashResultText, isBashTool } from "./translate/bash.js";
import { toolResultToText } from "./translate/pi-tools.js";

type SessionCreateParams = {
    readonly cwd: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly mcpServers: McpServer[];
    readonly conn: PiAcpClient;
    readonly fileCommands?: FileSlashCommand[];
    readonly piCommand?: string;
    readonly origin: Extract<PiSessionOrigin, { readonly kind: "new" | "fork" }>;
};

export type StopReason = "end_turn" | "cancelled" | "error";

type PendingTurn = {
    readonly questionSignal: AbortSignal;
    resolve: (reason: StopReason) => void;
    reject: (err: unknown) => void;
};

type QueuedTurn = {
    message: string;
    images: unknown[];
    resolve: (reason: StopReason) => void;
    reject: (err: unknown) => void;
};

type PiSteerOutcome = { readonly kind: "idle" } | { readonly kind: "injected" };

const nativeUserMessageSchema = z.object({
    role: z.literal("user"),
    content: z.union([
        z.string().transform((text) => [{ type: "text" as const, text }]),
        z.array(
            z.discriminatedUnion("type", [
                z.object({ type: z.literal("text"), text: z.string() }),
                z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
            ]),
        ),
    ]),
});

function toUsageUpdate(stats: PiSessionStats | null | undefined): PiSessionUpdate | null {
    const used = stats?.contextUsage?.tokens;
    const size = stats?.contextUsage?.contextWindow;

    if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) {
        return null;
    }
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
        return null;
    }

    return { sessionUpdate: "usage_update", used, size };
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
    if (!needle) {
        return undefined;
    }

    const first = text.indexOf(needle);
    if (first < 0) {
        return undefined;
    }

    const second = text.indexOf(needle, first + needle.length);
    if (second >= 0) {
        return undefined;
    }

    let line = 1;
    for (let i = 0; i < first; i += 1) {
        if (text.charCodeAt(i) === 10) {
            line += 1;
        }
    }
    return line;
}

function getToolPath(args: unknown): string | undefined {
    const record = args as { path?: unknown; file_path?: unknown } | null | undefined;
    if (typeof record?.path === "string") {
        return record.path;
    }
    if (typeof record?.file_path === "string") {
        return record.file_path;
    }
    return undefined;
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
    const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined;
    const parsed: Array<{ oldText: string; newText: string }> = [];

    if (typeof record?.oldText === "string" && typeof record?.newText === "string") {
        parsed.push({ oldText: record.oldText, newText: record.newText });
    }

    let edits = record?.edits;
    if (typeof edits === "string") {
        try {
            edits = JSON.parse(edits) as unknown;
        } catch {
            edits = undefined;
        }
    }

    if (Array.isArray(edits)) {
        for (const edit of edits) {
            const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined;
            if (typeof item?.oldText === "string" && typeof item?.newText === "string") {
                parsed.push({ oldText: item.oldText, newText: item.newText });
            }
        }
    }

    return parsed;
}

function getEditOldTexts(args: unknown): string[] {
    const record = args as { oldText?: unknown; edits?: unknown } | null | undefined;
    const oldTexts = getParsedEdits(args).map((edit) => edit.oldText);

    if (typeof record?.oldText === "string" && !oldTexts.includes(record.oldText)) {
        oldTexts.push(record.oldText);
    }

    let edits = record?.edits;
    if (typeof edits === "string") {
        try {
            edits = JSON.parse(edits) as unknown;
        } catch {
            edits = undefined;
        }
    }

    if (Array.isArray(edits)) {
        for (const edit of edits) {
            const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText;
            if (typeof oldText === "string" && !oldTexts.includes(oldText)) {
                oldTexts.push(oldText);
            }
        }
    }

    return oldTexts;
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
    const path = getToolPath(args);
    if (!path) {
        return undefined;
    }

    const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path);
    return [{ path: resolvedPath, ...(typeof line === "number" ? { line } : {}) }];
}

export class SessionManager {
    private sessions = new Map<string, PiAcpSession>();
    private readonly store = new SessionStore();
    private readonly teardowns = new Set<Promise<void>>();
    private readonly creating = new Set<Promise<PiAcpSession>>();

    constructor(
        private readonly signal: AbortSignal,
        private readonly processes: PiProcessHost,
    ) {}

    async disposeAll(): Promise<void> {
        await Promise.allSettled([...this.creating]);
        for (const [id] of this.sessions) {
            this.close(id);
        }
        const results = await Promise.allSettled([...this.teardowns]);
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
            throw new AggregateError(
                failures.map((failure) => failure.reason),
                "Pi processes could not be released",
            );
        }
    }

    maybeGet(sessionId: string): PiAcpSession | undefined {
        return this.sessions.get(sessionId);
    }

    close(sessionId: string): void {
        const s = this.sessions.get(sessionId);
        if (!s) {
            return;
        }
        try {
            const teardown = s.dispose();
            this.teardowns.add(teardown);
            void teardown.then(
                () => this.teardowns.delete(teardown),
                () => {
                    /* Retain failed cleanup so disposal reports it. */
                },
            );
        } catch {}
        this.sessions.delete(sessionId);
    }

    closeAllExcept(keepSessionId: string): void {
        for (const [id] of this.sessions) {
            if (id === keepSessionId) {
                continue;
            }
            this.close(id);
        }
    }

    async create(params: SessionCreateParams): Promise<PiAcpSession> {
        const acquisition = this.createNativeSession(params);
        this.creating.add(acquisition);
        try {
            return await acquisition;
        } finally {
            this.creating.delete(acquisition);
        }
    }

    private async createNativeSession(params: SessionCreateParams): Promise<PiAcpSession> {
        this.signal.throwIfAborted();
        // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
        // so sessions are visible to the regular `pi` CLI.
        let proc: PiRpcProcess;
        try {
            proc = await PiRpcProcess.spawn({
                processes: this.processes,
                cwd: params.cwd,
                environment: params.environment,
                origin: params.origin,
                signal: this.signal,
                piCommand: params.piCommand,
            });
        } catch (e) {
            if (e instanceof PiRpcSpawnError) {
                throw RequestError.internalError({ code: e.code }, e.message);
            }
            throw e;
        }

        if (this.signal.aborted) {
            await proc.dispose();
            this.signal.throwIfAborted();
        }

        let state: any = null;
        try {
            state = (await proc.getState()) as any;
        } catch {
            state = null;
        }

        if (this.signal.aborted) {
            await proc.dispose();
            this.signal.throwIfAborted();
        }

        const sessionId = typeof state?.sessionId === "string" ? state.sessionId : crypto.randomUUID();
        const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;

        if (sessionFile) {
            this.store.upsert({ sessionId, cwd: params.cwd, sessionFile });
        }

        const session = new PiAcpSession({
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers,
            proc,
            conn: params.conn,
            fileCommands: params.fileCommands ?? [],
        });

        this.sessions.set(sessionId, session);
        return session;
    }

    get(sessionId: string): PiAcpSession {
        const s = this.sessions.get(sessionId);
        if (!s) {
            throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`);
        }
        return s;
    }

    getOrCreate(
        sessionId: string,
        params: Omit<SessionCreateParams, "environment" | "piCommand" | "origin"> & { proc: PiRpcProcess },
    ): PiAcpSession {
        const existing = this.sessions.get(sessionId);
        if (existing) {
            return existing;
        }

        const session = new PiAcpSession({
            sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers,
            proc: params.proc,
            conn: params.conn,
            fileCommands: params.fileCommands ?? [],
        });

        this.sessions.set(sessionId, session);
        return session;
    }
}

export class PiAcpSession {
    readonly sessionId: string;
    readonly cwd: string;
    readonly mcpServers: McpServer[];

    private startupInfo: string | null = null;
    private startupInfoSent = false;

    readonly proc: PiRpcProcess;
    private readonly conn: PiAcpClient;
    private readonly extensionQuestions: PiExtensionQuestions;
    private readonly fileCommands: FileSlashCommand[];

    private cancelRequested = false;

    private turnRetryFailure: string | null = null;

    private pendingTurn: PendingTurn | null = null;
    private readonly turnQueue: QueuedTurn[] = [];
    // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
    // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
    // and clients may hide progress if we ever downgrade back to `pending`.
    private currentToolCalls = new Map<string, "pending" | "in_progress">();

    // For ACP diff support: capture file contents before edit/write mutations,
    // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
    // events may need to be implemented in pi in the future.
    private fileSnapshots = new Map<string, { path: string; oldText: string | null }>();
    private fileMutationToolCallIds = new Set<string>();
    private bashToolCallIds = new Set<string>();

    // Ensure `session/update` notifications are sent in order and can be awaited
    // before completing a `session/prompt` request.
    private lastEmit: Promise<void> = Promise.resolve();

    // Agent-owned ID of the in-flight context compaction, if any. pi reports only
    // lifecycle boundaries (no streamed summary), so one slot suffices.
    private activeCompactionId: string | null = null;

    /** Allocates (or clears) the compaction ID for the ACP compaction lifecycle.
     *  Opening always yields an id (allocating one if none is open); closing
     *  returns null when no compaction was open — an `auto_compaction_end`
     *  without a matching start (e.g. replayed from a persisted session) has no
     *  entity to patch, and fabricating an id would report a compaction the
     *  client never saw open. */
    private compactionId(open: boolean): string | null {
        if (!open) {
            const settled = this.activeCompactionId;
            this.activeCompactionId = null;
            return settled;
        }
        if (this.activeCompactionId === null) {
            this.activeCompactionId = randomUUID();
        }
        return this.activeCompactionId;
    }

    private openCompactionId(): string {
        return this.compactionId(true) ?? randomUUID();
    }

    constructor(opts: {
        sessionId: string;
        cwd: string;
        mcpServers: McpServer[];
        proc: PiRpcProcess;
        conn: PiAcpClient;
        fileCommands?: FileSlashCommand[];
    }) {
        this.sessionId = opts.sessionId;
        this.cwd = opts.cwd;
        this.mcpServers = opts.mcpServers;
        this.proc = opts.proc;
        this.conn = opts.conn;
        this.fileCommands = opts.fileCommands ?? [];

        this.extensionQuestions = new PiExtensionQuestions(this.sessionId, this.conn, this.proc, async (text) => {
            this.emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
            });
            await this.flushEmits();
        });
        this.proc.signal.addEventListener(
            "abort",
            () => {
                const cause: unknown = this.proc.signal.reason;
                if (cause instanceof PiRpcProcessError) {
                    const pending = this.pendingTurn;
                    const reason: unknown = pending?.questionSignal.reason;
                    const error =
                        reason instanceof RequestError
                            ? reason
                            : RequestError.internalError({ code: cause.code, details: cause.message });
                    if (!(reason instanceof RequestError)) {
                        error.cause = cause;
                    }
                    this.extensionQuestions.endTurn(error);
                    this.pendingTurn = null;
                    void this.flushEmits().then(() => {
                        if (this.cancelRequested) {
                            pending?.resolve("cancelled");
                        } else {
                            pending?.reject(error);
                        }
                    });
                } else {
                    this.extensionQuestions.endTurn();
                }
            },
            { once: true },
        );
        this.proc.onEvent((ev) => this.handlePiEvent(ev));
    }

    dispose(): Promise<void> {
        this.extensionQuestions.endTurn();
        return this.proc.dispose();
    }

    setStartupInfo(text: string) {
        this.startupInfo = text;
        this.startupInfoSent = false;
    }

    /**
     * Best-effort attempt to send startup info outside of a prompt turn.
     * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
     * callers can invoke this shortly after session/new returns.
     */
    sendStartupInfoIfPending(): void {
        if (this.startupInfoSent || !this.startupInfo) {
            return;
        }
        this.startupInfoSent = true;

        this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: this.startupInfo },
        });
    }

    async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
        // pi RPC mode disables slash command expansion, so we do it here.
        const expandedMessage = expandSlashCommand(message, this.fileCommands);

        const turnPromise = new Promise<StopReason>((resolve, reject) => {
            const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject };

            if (this.pendingTurn) {
                this.turnQueue.push(queued);

                // Best-effort: notify client that a prompt was queued.
                // This doesn't work in Zed yet, needs to be revisited
                this.emit({
                    sessionUpdate: "agent_message_chunk",
                    content: {
                        type: "text",
                        text: `Queued message (position ${this.turnQueue.length}).`,
                    },
                });

                this.emit({
                    sessionUpdate: "session_info_update",
                    _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } },
                });

                return;
            }

            this.startTurn(queued);
        });

        return turnPromise;
    }

    async compact(customInstructions: string | undefined, timeoutMs: number): Promise<unknown> {
        const signal = this.extensionQuestions.startTurn();
        try {
            const result = await this.proc.compact(customInstructions, { signal, timeoutMs });
            if (signal.aborted && signal.reason instanceof RequestError) {
                throw signal.reason;
            }
            return result;
        } catch (cause) {
            if (signal.aborted && signal.reason instanceof RequestError) {
                // Cancelling a local RPC wait does not stop native compaction.
                // Pi's abort response acknowledges that the operation is idle.
                try {
                    await this.proc.abort({ signal: this.proc.signal, timeoutMs });
                } catch (abortCause) {
                    if (!this.proc.signal.aborted) {
                        this.proc.terminateAfterFailure(abortCause);
                    }
                }
                throw signal.reason;
            }
            throw cause;
        } finally {
            this.extensionQuestions.endTurn();
            await this.flushEmits();
        }
    }

    async steer(message: string, images: unknown[], signal: AbortSignal): Promise<PiSteerOutcome> {
        const target = this.pendingTurn;
        if (target === null) {
            return { kind: "idle" };
        }
        const expandedMessage = expandSlashCommand(message, this.fileCommands);
        try {
            await this.proc.steer(expandedMessage, images, signal);
        } catch (error: unknown) {
            if (this.pendingTurn !== target) {
                return { kind: "idle" };
            }
            throw error;
        }
        return { kind: "injected" };
    }

    async cancel(): Promise<void> {
        this.cancelRequested = true;
        this.extensionQuestions.endTurn();

        if (this.turnQueue.length) {
            const queued = this.turnQueue.splice(0, this.turnQueue.length);
            for (const t of queued) {
                t.resolve("cancelled");
            }

            this.emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Cleared queued prompts." },
            });
            this.emit({
                sessionUpdate: "session_info_update",
                _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } },
            });
        }

        try {
            await this.proc.abort();
        } catch (cause) {
            // Closing the endpoint can terminate Pi before its abort acknowledgement arrives.
            if (!this.proc.signal.aborted) {
                throw cause;
            }
        }
    }

    wasCancelRequested(): boolean {
        return this.cancelRequested;
    }

    private emit(update: PiSessionUpdate): void {
        this.lastEmit = this.lastEmit
            .then(() =>
                this.conn.sessionUpdate({
                    sessionId: this.sessionId,
                    update,
                }),
            )
            .catch(() => {
                // Ignore notification errors (client may have gone away). We still want
                // prompt completion.
            });
    }

    private async flushEmits(): Promise<void> {
        await this.lastEmit;
    }

    /**
     * Best-effort: publish the real pi context-window occupancy as ACP `usage_update`.
     * Queued updates are flushed even when the stats query fails or times out, so callers
     * can await this before resolving `session/prompt`.
     */
    async publishContextUsage(): Promise<void> {
        try {
            // Older/stubbed pi processes may not expose the stats RPC at all.
            if (typeof this.proc.getSessionStats === "function") {
                const update = toUsageUpdate(await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS));
                if (update) {
                    this.emit(update);
                }
            }
        } catch {
            // Context usage is auxiliary; never fail or delay the turn because of it.
        }

        await this.flushEmits();
    }

    private async settleTurn(): Promise<void> {
        const questionSignal = this.pendingTurn?.questionSignal;
        this.extensionQuestions.endTurn();
        // Ensure all updates derived from pi events (plus the final usage update) are
        // delivered before we resolve the ACP `session/prompt` request.
        await this.publishContextUsage();

        // Exhausted retries terminated the turn with a model error. Reject the ACP
        // prompt with that error (mirroring the Claude harness's failActive and
        // Codex's failed-turn contract) instead of reporting a normal end_turn.
        // pi itself settled normally, so queued prompts still proceed; only the
        // model call failed, not the agent. A cancellation that raced the
        // exhaustion still settles as cancelled.
        const retryFailure = this.turnRetryFailure;
        this.turnRetryFailure = null;
        if (questionSignal?.aborted && questionSignal.reason instanceof RequestError && !this.cancelRequested) {
            this.pendingTurn?.reject(questionSignal.reason);
        } else if (retryFailure !== null && !this.cancelRequested) {
            this.pendingTurn?.reject(
                // The message rides in `data.details` so clients that unwrap the
                // JSON-RPC internal-error envelope (like Morty) surface the real
                // model error; `code` keeps the failure machine-readable.
                RequestError.internalError({
                    code: "pi_retries_exhausted",
                    details: `Pi retries exhausted: ${retryFailure}`,
                }),
            );
        } else {
            const reason: StopReason = this.cancelRequested ? "cancelled" : "end_turn";
            this.pendingTurn?.resolve(reason);
        }
        this.pendingTurn = null;

        const next = this.turnQueue.shift();
        if (next) {
            this.emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `Starting queued message. (${this.turnQueue.length} remaining)` },
            });
            this.startTurn(next);
        } else {
            this.emit({
                sessionUpdate: "session_info_update",
                _meta: { piAcp: { queueDepth: 0, running: false } },
            });
        }
    }

    private emitBashToolCall(params: {
        sessionUpdate: "tool_call" | "tool_call_update";
        toolCallId: string;
        toolName: string;
        args: unknown;
        status: "pending" | "in_progress";
        locations?: ToolCallLocation[];
    }): void {
        this.bashToolCallIds.add(params.toolCallId);
        this.emit({
            sessionUpdate: params.sessionUpdate,
            toolCallId: params.toolCallId,
            title: bashCommand(params.args) ?? params.toolName,
            kind: "execute",
            status: params.status,
            locations: params.locations,
            rawInput: params.args,
        });
    }

    private emitBashOutputUpdate(params: {
        toolCallId: string;
        status: "in_progress" | "completed" | "failed";
        result: unknown;
    }): void {
        const text = bashResultText(params.result);
        const isSettled = params.status === "completed" || params.status === "failed";
        this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId: params.toolCallId,
            status: params.status,
            content: text
                ? ([{ type: "content", content: { type: "text", text } }] satisfies ToolCallContent[])
                : undefined,
            ...(isSettled ? { rawOutput: params.result } : {}),
        });
    }

    private cleanupToolCall(toolCallId: string): void {
        this.currentToolCalls.delete(toolCallId);
        this.fileSnapshots.delete(toolCallId);
        this.fileMutationToolCallIds.delete(toolCallId);
        this.bashToolCallIds.delete(toolCallId);
    }

    private startTurn(t: QueuedTurn): void {
        const questionSignal = this.extensionQuestions.startTurn();
        this.cancelRequested = false;
        this.turnRetryFailure = null;

        this.pendingTurn = { questionSignal, resolve: t.resolve, reject: t.reject };

        // Publish queue depth (0 because we're starting the turn now).
        this.emit({
            sessionUpdate: "session_info_update",
            _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } },
        });

        // Kick off pi, but completion is determined by pi events, not the RPC response.
        // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
        // continuations may emit multiple `agent_end` events before `agent_settled`.
        this.proc.prompt(t.message, t.images).catch((err) => {
            this.extensionQuestions.endTurn();
            // If the subprocess errors before we get `agent_settled`, treat as error unless cancelled.
            // Also ensure we flush any already-enqueued updates first.
            void this.flushEmits().finally(() => {
                // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
                const authErr = maybeAuthRequiredError(err);
                if (authErr) {
                    this.pendingTurn?.reject(authErr);
                } else {
                    const reason: StopReason = this.cancelRequested ? "cancelled" : "error";
                    this.pendingTurn?.resolve(reason);
                }

                this.pendingTurn = null;

                // If the prompt failed, do not automatically proceed—pi may be unhealthy.
                // But we still clear the queueDepth metadata.
                this.emit({
                    sessionUpdate: "session_info_update",
                    _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } },
                });
            });
            void err;
        });
    }

    private handlePiEvent(ev: PiRpcEvent) {
        const type = String((ev as any).type ?? "");

        switch (type) {
            case "message_start": {
                const message = nativeUserMessageSchema.safeParse(ev.message);
                if (!message.success) {
                    break;
                }
                // Reset identity in delivery order, not when the RPC event arrives:
                // multiple native user messages can precede the queued notifications.
                this.lastEmit = this.lastEmit.then(() => this.conn.startUserMessage());
                for (const content of message.data.content) {
                    this.emit({ sessionUpdate: "user_message_chunk", content });
                }
                break;
            }
            case "message_update": {
                const ame = (ev as any).assistantMessageEvent;

                // Assistant content streaming means the current model call succeeded.
                // Exhaustion does not end pi's run — it may still recover through a
                // later retry, compaction continuation, queued input, or steering —
                // and pi 1.1.0 resets its retry counter at exhaustion, so a later
                // success emits no auto_retry_end at all. Any mid-run retry failure
                // is therefore superseded the moment a recovered response streams,
                // and the turn settles by its final outcome instead of an error it
                // already recovered from.
                if (
                    this.turnRetryFailure !== null &&
                    (ame?.type === "text_delta" || ame?.type === "thinking_delta" || ame?.type === "toolcall_start")
                ) {
                    this.turnRetryFailure = null;
                }

                if (ame?.type === "text_delta" && typeof ame.delta === "string") {
                    this.emit({
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: ame.delta } satisfies ContentBlock,
                    });
                    break;
                }

                if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
                    this.emit({
                        sessionUpdate: "agent_thought_chunk",
                        content: { type: "text", text: ame.delta } satisfies ContentBlock,
                    });
                    break;
                }

                // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
                // while the model is still streaming tool call args.
                if (ame?.type === "toolcall_start" || ame?.type === "toolcall_delta" || ame?.type === "toolcall_end") {
                    const toolCall =
                        // pi sometimes includes the tool call directly on the event
                        (ame as any)?.toolCall ??
                        // ...and always includes it in the partial assistant message at contentIndex
                        (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0];

                    const toolCallId = String((toolCall as any)?.id ?? "");
                    const toolName = String((toolCall as any)?.name ?? "tool");

                    if (toolCallId) {
                        const rawInput =
                            (toolCall as any)?.arguments && typeof (toolCall as any).arguments === "object"
                                ? (toolCall as any).arguments
                                : (() => {
                                      const s = String((toolCall as any)?.partialArgs ?? "");
                                      if (!s) {
                                          return undefined;
                                      }
                                      try {
                                          return JSON.parse(s);
                                      } catch {
                                          return { partialArgs: s };
                                      }
                                  })();

                        const locations = toToolCallLocations(rawInput, this.cwd);
                        const existingStatus = this.currentToolCalls.get(toolCallId);
                        // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
                        const status = existingStatus ?? "pending";

                        if (isBashTool(toolName)) {
                            if (!existingStatus) {
                                this.currentToolCalls.set(toolCallId, "pending");
                            }
                            this.emitBashToolCall({
                                sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
                                toolCallId,
                                toolName,
                                args: rawInput,
                                status,
                                locations,
                            });
                        } else if (!existingStatus) {
                            this.currentToolCalls.set(toolCallId, "pending");
                            this.emit({
                                sessionUpdate: "tool_call",
                                toolCallId,
                                title: toolName,
                                kind: toToolKind(toolName),
                                status,
                                locations,
                                rawInput,
                            });
                        } else {
                            this.emit({
                                sessionUpdate: "tool_call_update",
                                toolCallId,
                                status,
                                locations,
                                rawInput,
                            });
                        }
                    }

                    break;
                }

                break;
            }

            case "tool_execution_start": {
                const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID());
                const toolName = String((ev as any).toolName ?? "tool");
                const args = (ev as any).args;
                let line: number | undefined;

                if (isBashTool(toolName)) {
                    const locations = toToolCallLocations(args, this.cwd);
                    const existingStatus = this.currentToolCalls.get(toolCallId);
                    this.currentToolCalls.set(toolCallId, "in_progress");
                    this.emitBashToolCall({
                        sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
                        toolCallId,
                        toolName,
                        args,
                        status: "in_progress",
                        locations,
                    });
                    break;
                }

                // Capture pre-mutation file contents so we can emit a structured ACP diff.
                const isFileMutation = toolName === "edit" || toolName === "write";
                let snapshotOldText: string | null | undefined;
                if (isFileMutation) {
                    this.fileMutationToolCallIds.add(toolCallId);
                    const p = getToolPath(args);
                    if (p) {
                        try {
                            const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p);
                            snapshotOldText = readFileSync(abs, "utf8");
                            this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText });

                            if (toolName === "edit") {
                                for (const needle of getEditOldTexts(args)) {
                                    line = findUniqueLineNumber(snapshotOldText, needle);
                                    if (typeof line === "number") {
                                        break;
                                    }
                                }
                            }
                        } catch {
                            snapshotOldText = null;
                            this.fileSnapshots.set(toolCallId, { path: p, oldText: null });
                        }
                    }
                }

                const locations = toToolCallLocations(args, this.cwd, line);

                if (!this.currentToolCalls.has(toolCallId)) {
                    this.currentToolCalls.set(toolCallId, "in_progress");
                    this.emit({
                        sessionUpdate: "tool_call",
                        toolCallId,
                        title: toolName,
                        kind: toToolKind(toolName),
                        status: "in_progress",
                        locations,
                        rawInput: args,
                    });
                } else {
                    this.currentToolCalls.set(toolCallId, "in_progress");
                    this.emit({
                        sessionUpdate: "tool_call_update",
                        toolCallId,
                        status: "in_progress",
                        locations,
                        rawInput: args,
                    });
                }

                break;
            }

            case "tool_execution_update": {
                const toolCallId = String((ev as any).toolCallId ?? "");
                if (!toolCallId) {
                    break;
                }

                const partial = (ev as any).partialResult;
                if (this.bashToolCallIds.has(toolCallId)) {
                    this.emitBashOutputUpdate({ toolCallId, status: "in_progress", result: partial });
                    break;
                }

                const text = this.fileMutationToolCallIds.has(toolCallId) ? "" : toolResultToText(partial);

                this.emit({
                    sessionUpdate: "tool_call_update",
                    toolCallId,
                    status: "in_progress",
                    content: text
                        ? ([{ type: "content", content: { type: "text", text } }] satisfies ToolCallContent[])
                        : undefined,
                    ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial }),
                });
                break;
            }

            case "tool_execution_end": {
                const toolCallId = String((ev as any).toolCallId ?? "");
                if (!toolCallId) {
                    break;
                }

                const result = (ev as any).result;
                const isError = Boolean((ev as any).isError);
                if (this.bashToolCallIds.has(toolCallId)) {
                    this.emitBashOutputUpdate({
                        toolCallId,
                        status: isError ? "failed" : "completed",
                        result,
                    });
                    this.cleanupToolCall(toolCallId);
                    break;
                }

                const text = toolResultToText(result);

                const snapshot = this.fileSnapshots.get(toolCallId);
                let content: ToolCallContent[] | undefined;
                let hasStructuredDiff = false;

                if (!isError && snapshot) {
                    try {
                        const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path);
                        const newText = readFileSync(abs, "utf8");
                        if (snapshot.oldText === null || newText !== snapshot.oldText) {
                            hasStructuredDiff = true;
                            content = [
                                {
                                    type: "diff",
                                    path: snapshot.path,
                                    oldText: snapshot.oldText,
                                    newText,
                                },
                            ];
                        }
                    } catch {}
                }

                if (!content && !hasStructuredDiff && text) {
                    content = [{ type: "content", content: { type: "text", text } }] satisfies ToolCallContent[];
                }

                this.emit({
                    sessionUpdate: "tool_call_update",
                    toolCallId,
                    status: isError ? "failed" : "completed",
                    content,
                    ...(hasStructuredDiff ? {} : { rawOutput: result }),
                });

                this.cleanupToolCall(toolCallId);
                break;
            }

            case "extension_ui_request": {
                if (ev.method === "notify") {
                    this.emit({
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: stringProp(ev, "message") ?? "Pi notification" },
                        _meta: { piAcp: { notify: { level: stringProp(ev, "notifyType") ?? "info" } } },
                    });
                    break;
                }
                void this.extensionQuestions.handle(ev);
                break;
            }

            case "auto_retry_start": {
                // Retry lifecycle is not model output; like the Claude and Codex
                // harnesses, it never enters the transcript. The retried attempt's
                // own assistant text (when it eventually streams) is the only thing
                // a client should see.
                break;
            }

            case "auto_retry_end": {
                // pi emits auto_retry_end for successful recovery (success: true),
                // exhausted retries (success: false with the final model error), and
                // a retry the user cancelled mid-backoff. Exhaustion does not end the
                // ACP turn by itself: pi keeps running (compaction, queued input,
                // pre-settle extension continuations), so the turn only fails when it
                // settles with no later success. Record the final error, and clear it
                // whenever a later attempt recovers, so a turn that ultimately answers
                // settles normally instead of being branded by a mid-run retry
                // failure. The failure itself is reported through the prompt error —
                // like the Claude and Codex harnesses, never through transcript
                // chunks. A cancelled retry settles as cancelled.
                if (ev.success === true) {
                    this.turnRetryFailure = null;
                    break;
                }
                if (!this.cancelRequested) {
                    const finalError = stringProp(ev, "finalError");
                    this.turnRetryFailure =
                        finalError !== null && finalError.length > 0
                            ? finalError
                            : "The Pi turn failed with a model error";
                }
                break;
            }

            case "auto_compaction_start": {
                this.emit({
                    compactionId: this.openCompactionId(),
                    sessionUpdate: "compaction_update",
                    status: "in_progress",
                });
                break;
            }

            case "auto_compaction_end": {
                const settled = this.compactionId(false);
                if (settled !== null) {
                    this.emit({
                        compactionId: settled,
                        sessionUpdate: "compaction_update",
                        status: "completed",
                    });
                }
                break;
            }

            case "agent_start": {
                break;
            }

            case "turn_end": {
                // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
                // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
                break;
            }

            case "agent_end": {
                // One low-level run ended. Pi may still retry, compact, or process a queued
                // continuation, so keep the ACP turn open until `agent_settled`.
                break;
            }

            case "agent_settled": {
                void this.settleTurn();
                break;
            }

            default:
                break;
        }
    }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];
    return typeof value === "string" ? value : null;
}

function toToolKind(toolName: string): ToolKind {
    switch (toolName) {
        case "read":
            return "read";
        case "write":
        case "edit":
            return "edit";
        case "bash":
            return "execute";
        default:
            return "other";
    }
}
