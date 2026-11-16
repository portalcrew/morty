import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
    type AuthenticateRequest,
    type AvailableCommand,
    type CancelNotification,
    type ContentBlock,
    type DeleteSessionRequest,
    type DeleteSessionResponse,
    type ForkSessionRequest,
    type ForkSessionResponse,
    type InitializeRequest,
    type InitializeResponse,
    type ListSessionsRequest,
    type ListSessionsResponse,
    type LoadSessionRequest,
    type LoadSessionResponse,
    type NewSessionRequest,
    type PromptRequest,
    type PromptResponse,
    RequestError,
    type ResumeSessionRequest,
    type ResumeSessionResponse,
    type SessionConfigOption,
    type SessionInfo,
    type SetSessionConfigOptionRequest,
    type SetSessionConfigOptionResponse,
    type SetSessionModeRequest,
    type SetSessionModeResponse,
    type StopReason,
} from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";
import { type PiProcessHost, PiRpcProcess } from "../pi-rpc/process.js";
import { getAuthMethods } from "./auth.js";
import { maybeAuthRequiredError } from "./auth-required.js";
import type { PiAcpClient } from "./client.js";
import { getPiAcpSessionMapPath } from "./paths.js";
import { toAvailableCommandsFromPiGetCommands } from "./pi-commands.js";
import { readPiHistory, readPiLatestEntryId } from "./pi-history.js";
import { findPiSession, listPiSessions } from "./pi-sessions.js";
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from "./pi-settings.js";
import { type PiAcpSession, SessionManager } from "./session.js";
import { SessionStore } from "./session-store.js";
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from "./slash-commands.js";
import { bashCommand, bashResultText, isBashTool } from "./translate/bash.js";
import { normalizePiAssistantText, piUserMessageContent } from "./translate/pi-messages.js";
import { toolResultToText } from "./translate/pi-tools.js";
import { promptToPiMessage } from "./translate/prompt.js";

type AdvertisedModel = {
    modelId: string;
    name: string;
    description?: string | null;
};

const MODEL_CONFIG_ID = "model";
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
// Compaction summarizes the session with one model call; generous but finite.
const COMPACT_TIMEOUT_MILLISECONDS = 3_600_000;

const contentBlockSchema: z.ZodType<ContentBlock> = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
    z.object({ type: z.literal("audio"), data: z.string(), mimeType: z.string() }),
    z.object({ type: z.literal("resource_link"), name: z.string(), uri: z.string() }),
    z.object({
        type: z.literal("resource"),
        resource: z.union([
            z.object({ mimeType: z.string().nullish(), text: z.string(), uri: z.string() }),
            z.object({ blob: z.string(), mimeType: z.string().nullish(), uri: z.string() }),
        ]),
    }),
]);

const revisionRequestSchema = z.object({ sessionId: z.string().min(1) });
const steerRequestSchema = z.object({
    _meta: z
        .object({
            steering: z.object({ idleBehavior: z.literal("promptRequired").optional() }).optional(),
        })
        .nullish(),
    prompt: z.array(contentBlockSchema).min(1),
    sessionId: z.string().min(1),
});

function thinkingLevelName(id: string): string {
    return id
        .split(/[_-]/u)
        .map((part) => (part.length === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
        .join(" ");
}

function builtinAvailableCommands(): AvailableCommand[] {
    return [
        {
            name: "compact",
            description: "Manually compact the session context",
            input: { hint: "optional custom instructions" },
        },
        {
            name: "autocompact",
            description: "Toggle automatic context compaction",
            input: { hint: "on|off|toggle" },
        },
        {
            name: "export",
            description: "Export session to an HTML file in the session cwd",
        },
        {
            name: "session",
            description: "Show session stats (messages, tokens, cost, session file)",
        },
        {
            name: "name",
            description: "Set session display name",
            input: { hint: "<name>" },
        },
        {
            name: "steering",
            description: "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
            input: { hint: "(no args to show) all | one-at-a-time" },
        },
        {
            name: "follow-up",
            description: "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
            input: { hint: "(no args to show) all | one-at-a-time" },
        },
        {
            name: "changelog",
            description: "Show pi changelog",
        },
    ];
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
    const out: AvailableCommand[] = [];
    const seen = new Set<string>();

    for (const c of [...a, ...b]) {
        if (seen.has(c.name)) {
            continue;
        }
        seen.add(c.name);
        out.push(c);
    }

    return out;
}

const PI_ACP_NAME = "pi-acp";
const PI_ACP_VERSION = "0.0.34";

export class PiAcpAgent {
    private readonly lifetime = new AbortController();
    readonly signal: AbortSignal = this.lifetime.signal;
    private closing: Promise<void> | null = null;
    private readonly pendingSubmissions = new Map<string, Set<AbortController>>();
    private readonly conn: PiAcpClient;
    private readonly sessions: SessionManager;
    private readonly processes: PiProcessHost;
    private readonly store: SessionStore;
    private readonly restoringSessions = new Map<string, Promise<PiAcpSession>>();
    private readonly environment: Readonly<NodeJS.ProcessEnv>;

    dispose(): Promise<void> {
        if (this.closing === null) {
            this.closing = Promise.resolve().then(async () => {
                await Promise.allSettled([...this.restoringSessions.values()]);
                await this.sessions.disposeAll();
            });
            this.lifetime.abort(new DOMException("The Pi client closed", "AbortError"));
        }
        return this.closing;
    }

    async sessionConfiguration(sessionId: string) {
        return await getSessionConfiguration(this.sessions.get(sessionId).proc);
    }

    private lastSessionCwd: string | null = null;

    constructor(
        conn: PiAcpClient,
        config: { readonly environment: Readonly<NodeJS.ProcessEnv>; readonly processes: PiProcessHost },
    ) {
        this.conn = conn;
        this.processes = config.processes;
        this.sessions = new SessionManager(this.signal, this.processes);
        this.environment = config.environment;
        this.store = new SessionStore(getPiAcpSessionMapPath(this.environment));
    }

    private cleanupFailedNewSession(sessionId: string, state?: any | null): void {
        this.sessions.close(sessionId);

        const sessionFile =
            typeof state?.sessionFile === "string" && state.sessionFile.trim()
                ? state.sessionFile
                : this.store.get(sessionId)?.sessionFile;

        if (typeof sessionFile === "string" && sessionFile.trim()) {
            try {
                if (existsSync(sessionFile)) {
                    unlinkSync(sessionFile);
                }
            } catch {
                // ignore cleanup failures; the auth/internal error is the primary result
            }
        }

        this.store.delete(sessionId);
    }

    private findStoredSession(sessionId: string): { cwd: string; sessionFile: string } | null {
        const stored = this.store.get(sessionId);
        if (stored?.cwd && stored?.sessionFile) {
            return { cwd: stored.cwd, sessionFile: stored.sessionFile };
        }

        const piSession = findPiSession(sessionId, this.environment);
        if (!piSession) {
            return null;
        }

        this.store.upsert({
            sessionId,
            cwd: piSession.cwd,
            sessionFile: piSession.sessionFile,
        });

        return {
            cwd: piSession.cwd,
            sessionFile: piSession.sessionFile,
        };
    }

    private async restoreSession(
        sessionId: string,
        opts?: { cwd?: string; mcpServers?: LoadSessionRequest["mcpServers"] },
    ): Promise<PiAcpSession> {
        const existing = this.sessions.maybeGet(sessionId);
        if (existing) {
            return existing;
        }

        const inFlight = this.restoringSessions.get(sessionId);
        if (inFlight) {
            return inFlight;
        }

        const restorePromise = (async () => {
            const stored = this.findStoredSession(sessionId);
            if (!stored) {
                throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`);
            }

            const cwd = opts?.cwd ?? stored.cwd;

            let proc: PiRpcProcess;
            try {
                proc = await PiRpcProcess.spawn({
                    processes: this.processes,
                    cwd,
                    origin: { kind: "load", sessionPath: stored.sessionFile },
                    piCommand: this.environment.PI_ACP_PI_COMMAND,
                    environment: this.environment,
                    signal: this.signal,
                });
            } catch (e: any) {
                if (e?.name === "PiRpcSpawnError") {
                    throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e));
                }
                throw e;
            }

            const fileCommands = loadSlashCommands(cwd, this.environment);
            if (this.signal.aborted) {
                await proc.dispose();
                this.signal.throwIfAborted();
            }
            const session = this.sessions.getOrCreate(sessionId, {
                cwd,
                mcpServers: opts?.mcpServers ?? [],
                conn: this.conn,
                proc,
                fileCommands,
            });

            this.lastSessionCwd = cwd;
            this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile });

            return session;
        })();

        this.restoringSessions.set(sessionId, restorePromise);

        try {
            return await restorePromise;
        } finally {
            this.restoringSessions.delete(sessionId);
        }
    }

    async initialize(params: InitializeRequest): Promise<InitializeResponse> {
        const supportedVersion = 1;
        const requested = params.protocolVersion;

        return {
            _meta: { steering: { supported: true } },
            protocolVersion: requested === supportedVersion ? requested : supportedVersion,
            agentInfo: {
                name: PI_ACP_NAME,
                title: "pi ACP adapter",
                version: PI_ACP_VERSION,
            },
            // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
            // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
            authMethods: getAuthMethods({
                command: this.environment["PI_ACP_PI_COMMAND"] ?? "pi",
                supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.["terminal-auth"] === true,
            }),
            agentCapabilities: {
                loadSession: true,
                mcpCapabilities: { http: false, sse: false },
                promptCapabilities: {
                    image: true,
                    audio: false,
                    embeddedContext: this.environment.PI_ACP_ENABLE_EMBEDDED_CONTEXT === "true",
                },
                sessionCapabilities: {
                    // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
                    // Enables a native session picker in clients that support it.
                    list: {},
                    delete: {},
                    fork: {},
                },
            },
        };
    }

    async newSession(params: NewSessionRequest) {
        if (!isAbsolute(params.cwd)) {
            throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
        }

        this.lastSessionCwd = params.cwd;

        const fileCommands = loadSlashCommands(params.cwd, this.environment);
        const enableSkillCommands = getEnableSkillCommands(params.cwd, this.environment);

        // Pi doesn't support mcpServers, but we accept and store.
        const session = await this.sessions.create({
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            conn: this.conn,
            fileCommands,
            piCommand: this.environment.PI_ACP_PI_COMMAND,
            environment: this.environment,
            origin: { kind: "new" },
        });

        // Fetch state + models once (parallel) to reduce startup latency.
        let state: any = null;
        let availableModels: any = null;
        let stateErr: unknown = null;
        let availableModelsErr: unknown = null;

        await Promise.all([
            session.proc
                .getState()
                .then((s) => {
                    state = s as any;
                })
                .catch((err) => {
                    stateErr = err;
                    state = null;
                }),
            session.proc
                .getAvailableModels()
                .then((m) => {
                    availableModels = m as any;
                })
                .catch((err) => {
                    availableModelsErr = err;
                    availableModels = null;
                }),
        ]);

        const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr);

        if (availableModelsAuthErr) {
            this.cleanupFailedNewSession(session.sessionId, state);
            throw availableModelsAuthErr;
        }

        if (availableModelsErr) {
            this.cleanupFailedNewSession(session.sessionId, state);
            throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr));
        }

        // If pi has no models available after spawning, it's effectively unauthenticated.
        const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0;

        if (rawModelsCount === 0) {
            this.cleanupFailedNewSession(session.sessionId, state);
            throw RequestError.authRequired(
                { authMethods: getAuthMethods() },
                "Configure an API key or log in with an OAuth provider.",
            );
        }

        if (stateErr && maybeAuthRequiredError(stateErr)) {
            this.cleanupFailedNewSession(session.sessionId, state);
            throw RequestError.authRequired(
                { authMethods: getAuthMethods() },
                "Configure an API key or log in with an OAuth provider.",
            );
        }

        let configuration: Awaited<ReturnType<typeof getSessionConfiguration>>;
        try {
            if (stateErr) {
                throw stateErr;
            }
            configuration = await getSessionConfiguration(session.proc, { state, availableModels });
        } catch (err) {
            this.cleanupFailedNewSession(session.sessionId, state);
            throw maybeAuthRequiredError(err) ?? RequestError.internalError({}, String((err as Error)?.message ?? err));
        }
        const { configOptions, models, modes } = configuration;

        const quietStartup = getQuietStartup(params.cwd, this.environment);
        const updateNotice = buildUpdateNotice();

        // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
        // the "New version available" notice (if any) since it's high-signal and actionable.
        const preludeText = quietStartup
            ? updateNotice
                ? `${updateNotice}\n`
                : ""
            : buildStartupInfo({
                  cwd: params.cwd,
                  environment: this.environment,
                  fileCommands,
                  updateNotice,
              });

        if (preludeText) {
            session.setStartupInfo(preludeText);
        }

        // Policy: within a single ACP connection (one client window), keep only one live pi subprocess.
        // This avoids leaking subprocesses when clients start new sessions but don't explicitly close old ones.
        // It does NOT affect other client windows because they run in separate agent processes.
        //
        // (Tests sometimes stub out `this.sessions`, so guard the call.)
        (this.sessions as any).closeAllExcept?.(session.sessionId);

        const response = {
            sessionId: session.sessionId,
            configOptions,
            models,
            modes,
            _meta: {
                piAcp: {
                    startupInfo: preludeText || null,
                },
            },
        };

        // Try to send it immediately after session/new returns; if the client ignores it,
        // it will still be emitted as the first chunk of the first prompt.
        if (preludeText) {
            setTimeout(() => session.sendStartupInfoIfPending(), 0);
        }

        // Advertise slash commands (ACP: available_commands_update)
        // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
        // So we must send this *after* the session/new response has been delivered.
        setTimeout(() => {
            void (async () => {
                // Publish real context usage now that the client knows the sessionId (clients ignore
                // notifications for unknown sessions), so the window size is correct before the first prompt.
                await session.publishContextUsage();

                try {
                    const pi = (await session.proc.getCommands()) as any;
                    const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
                        enableSkillCommands,
                        includeExtensionCommands: false,
                    });

                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "available_commands_update",
                            availableCommands: mergeCommands(commands, builtinAvailableCommands()),
                        },
                    });
                    return;
                } catch {}

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "available_commands_update",
                        availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands()),
                    },
                });
            })().catch(() => {
                // Session setup notifications are best-effort; the client or Pi process may close first.
            });
        }, 0);

        return response;
    }

    async authenticate(_params: AuthenticateRequest) {
        // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
        // If the client calls `authenticate` anyway, we can no-op successfully.
        return;
    }

    async prompt(params: PromptRequest): Promise<PromptResponse> {
        const controller = new AbortController();
        const pending = this.pendingSubmissions.get(params.sessionId) ?? new Set<AbortController>();
        pending.add(controller);
        this.pendingSubmissions.set(params.sessionId, pending);
        try {
            return await this.promptSubmission(params, controller.signal);
        } finally {
            pending.delete(controller);
            if (pending.size === 0) {
                this.pendingSubmissions.delete(params.sessionId);
            }
        }
    }

    private async promptSubmission(params: PromptRequest, submission: AbortSignal): Promise<PromptResponse> {
        const session = await this.restoreSession(params.sessionId);
        if (submission.aborted) {
            return { stopReason: "cancelled" };
        }
        const { message, images } = promptToPiMessage(params.prompt);

        // Built-in ACP slash command handling (headless-friendly subset).
        // Note: file-based slash commands are expanded inside session.prompt().
        if (images.length === 0 && message.trimStart().startsWith("/")) {
            const trimmed = message.trim();
            const space = trimmed.indexOf(" ");
            const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
            const argsString = space === -1 ? "" : trimmed.slice(space + 1);
            const args = parseCommandArgs(argsString);

            if (builtinAvailableCommands().some((command) => command.name === cmd)) {
                // Reset local reply grouping without fabricating a user chunk.
                this.conn.startUserMessage();
            }

            if (cmd === "compact") {
                const customInstructions = args.join(" ").trim() || undefined;
                const compactionId = randomUUID();
                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        compactionId,
                        sessionUpdate: "compaction_update",
                        status: "in_progress",
                    },
                });

                try {
                    // One model call to summarize the session: finite but generous,
                    // and cancellable like every external-system wait.
                    const res = await session.compact(customInstructions, COMPACT_TIMEOUT_MILLISECONDS);

                    const r: any = res && typeof res === "object" ? (res as any) : null;
                    const summary = typeof r?.summary === "string" ? r.summary : null;

                    if (summary !== null && summary.length > 0) {
                        await this.conn.sessionUpdate({
                            sessionId: session.sessionId,
                            update: {
                                compactionId,
                                content: { text: summary, type: "text" },
                                sessionUpdate: "compaction_summary_chunk",
                            },
                        });
                    }

                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            compactionId,
                            sessionUpdate: "compaction_update",
                            status: "completed",
                        },
                    });
                } catch (cause: unknown) {
                    // The compaction opened above must settle even when pi's
                    // compact RPC fails (e.g. "Nothing to compact"); report the
                    // failure reason through the update, then let the caller's
                    // error path surface the failure itself.
                    const details = cause instanceof Error ? cause.message : String(cause);
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            compactionId,
                            error: details,
                            sessionUpdate: "compaction_update",
                            status: "failed",
                        },
                    });
                    throw cause;
                }

                return { stopReason: "end_turn" };
            }

            if (cmd === "session") {
                const stats = await session.proc.getSessionStats();

                const lines: string[] = [];
                if (stats?.sessionId) {
                    lines.push(`Session: ${stats.sessionId}`);
                }
                if (stats?.sessionFile) {
                    lines.push(`Session file: ${stats.sessionFile}`);
                }
                if (typeof stats?.totalMessages === "number") {
                    lines.push(`Messages: ${stats.totalMessages}`);
                }

                if (typeof stats?.cost === "number") {
                    lines.push(`Cost: ${stats.cost}`);
                }

                const t = stats?.tokens;
                if (t && typeof t === "object") {
                    const parts: string[] = [];
                    if (typeof t.input === "number") {
                        parts.push(`in ${t.input}`);
                    }
                    if (typeof t.output === "number") {
                        parts.push(`out ${t.output}`);
                    }
                    if (typeof t.cacheRead === "number") {
                        parts.push(`cache read ${t.cacheRead}`);
                    }
                    if (typeof t.cacheWrite === "number") {
                        parts.push(`cache write ${t.cacheWrite}`);
                    }
                    if (typeof t.total === "number") {
                        parts.push(`total ${t.total}`);
                    }
                    if (parts.length) {
                        lines.push(`Tokens: ${parts.join(", ")}`);
                    }
                }

                const text = lines.length ? lines.join("\n") : `Session stats:\n${JSON.stringify(stats, null, 2)}`;

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text },
                    },
                });

                return { stopReason: "end_turn" };
            }

            if (cmd === "name") {
                const name = args.join(" ").trim();
                if (!name) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "Usage: /name <name>" },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                try {
                    await session.proc.setSessionName(name);
                } catch (e: any) {
                    const msg = String(e?.message ?? e);
                    const hint = /set_session_name/i.test(msg)
                        ? " This requires a newer pi version that supports `set_session_name` in RPC mode."
                        : "";

                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: `Failed to set session name: ${msg}${hint}` },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "session_info_update",
                        title: name,
                        updatedAt: new Date().toISOString(),
                    },
                });

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: `Session name set: ${name}` },
                    },
                });

                return { stopReason: "end_turn" };
            }

            if (cmd === "steering") {
                const modeRaw = String(args[0] ?? "").toLowerCase();
                const state = (await session.proc.getState()) as any;
                const current = String(state?.steeringMode ?? "");

                if (!modeRaw) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                                type: "text",
                                text: `Steering mode: ${current || "unknown"}`,
                            },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                                type: "text",
                                text: "Usage: /steering all | /steering one-at-a-time",
                            },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                await session.proc.setSteeringMode(modeRaw as "all" | "one-at-a-time");

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: `Steering mode set to: ${modeRaw}` },
                    },
                });

                return { stopReason: "end_turn" };
            }

            if (cmd === "follow-up") {
                const modeRaw = String(args[0] ?? "").toLowerCase();
                const state = (await session.proc.getState()) as any;
                const current = String(state?.followUpMode ?? "");

                if (!modeRaw) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                                type: "text",
                                text: `Follow-up mode: ${current || "unknown"}`,
                            },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                                type: "text",
                                text: "Usage: /follow-up all | /follow-up one-at-a-time",
                            },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                await session.proc.setFollowUpMode(modeRaw as "all" | "one-at-a-time");

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` },
                    },
                });

                return { stopReason: "end_turn" };
            }

            if (cmd === "changelog") {
                const findChangelog = (): string | null => {
                    try {
                        const whichCmd = process.platform === "win32" ? "where" : "which";
                        const which = spawnSync(whichCmd, ["pi"], { encoding: "utf-8" });
                        const piPath = String(which.stdout ?? "")
                            .split(/\r?\n/)[0]
                            ?.trim();

                        if (piPath) {
                            const resolved = realpathSync(piPath);
                            const pkgRoot = dirname(dirname(resolved));
                            const p = join(pkgRoot, "CHANGELOG.md");
                            if (existsSync(p)) {
                                return p;
                            }
                        }
                    } catch {}

                    try {
                        const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
                        const root = String(npmRoot.stdout ?? "").trim();
                        if (root) {
                            const p = join(root, "@earendil-works", "pi-coding-agent", "CHANGELOG.md");
                            if (existsSync(p)) {
                                return p;
                            }
                        }
                    } catch {}

                    return null;
                };

                const changelogPath = findChangelog();
                if (!changelogPath) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "Changelog not found (couldn't locate pi installation)." },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                let text = "";
                try {
                    text = readFileSync(changelogPath, "utf-8");
                } catch (e: any) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: `Failed to read changelog: ${String(e?.message ?? e)}` },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                // Keep it reasonably sized in chat.
                const maxChars = 20_000;
                if (text.length > maxChars) {
                    text = `${text.slice(0, maxChars)}\n\n...(truncated)...`;
                }

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text },
                    },
                });

                return { stopReason: "end_turn" };
            }

            if (cmd === "export") {
                // For now we always export into the session cwd and do not accept a user-provided path.
                // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
                // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
                // (no id), which would otherwise hang our request. So we guard here.
                const state = (await session.proc.getState()) as any;
                const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
                const messageCount = typeof state?.messageCount === "number" ? state.messageCount : 0;

                if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                                type: "text",
                                text: "Nothing to export yet (no session messages). Send a prompt first.",
                            },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                try {
                    const raw = readFileSync(sessionFile, "utf-8");
                    if (raw.trim().length === 0) {
                        await this.conn.sessionUpdate({
                            sessionId: session.sessionId,
                            update: {
                                sessionUpdate: "agent_message_chunk",
                                content: {
                                    type: "text",
                                    text: "Nothing to export yet (empty session file). Send a prompt first.",
                                },
                            },
                        });
                        return { stopReason: "end_turn" };
                    }
                } catch {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                                type: "text",
                                text: "Couldn't read session file for export. Try sending a prompt first.",
                            },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
                const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`);

                let resultPath = "";
                try {
                    const result = await session.proc.exportHtml(outputPath);
                    resultPath = result.path;
                } catch (e: any) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                                type: "text",
                                text: `Export failed: ${String(e?.message ?? e)}`,
                            },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                if (!resultPath) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: {
                                type: "text",
                                text: "Export failed: no output path returned by pi.",
                            },
                        },
                    });
                    return { stopReason: "end_turn" };
                }

                const uri = `file://${resultPath}`;

                // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
                // assistant message, so this avoids the "link + duplicate plain text" look.
                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: {
                            type: "text",
                            text: "Session exported: ",
                        },
                    },
                });

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: {
                            type: "resource_link",
                            name: `pi-session-${safeSessionId}.html`,
                            uri,
                            mimeType: "text/html",
                            title: "Session exported",
                        },
                    },
                });

                return { stopReason: "end_turn" };
            }

            if (cmd === "autocompact") {
                const mode = (args[0] ?? "toggle").toLowerCase();
                let enabled: boolean | null = null;
                if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") {
                    enabled = true;
                } else if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled") {
                    enabled = false;
                }

                if (enabled === null) {
                    const state = (await session.proc.getState()) as any;
                    const current = Boolean(state?.autoCompactionEnabled);
                    enabled = !current;
                }

                await session.proc.setAutoCompaction(enabled);

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: {
                            type: "text",
                            text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`,
                        },
                    },
                });

                return { stopReason: "end_turn" };
            }
        }

        if (submission.aborted) {
            return { stopReason: "cancelled" };
        }
        const result = await session.prompt(message, images);

        // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
        // unless we know this was a cancellation.
        const stopReason: StopReason =
            result === "error" ? (session.wasCancelRequested() ? "cancelled" : "end_turn") : result;

        return { stopReason };
    }

    async readSessionRevision(params: unknown): Promise<{ readonly latestEntryId: string }> {
        const parsed = revisionRequestSchema.safeParse(params);
        if (!parsed.success) {
            throw RequestError.invalidParams("Invalid revision request");
        }
        const stored = this.findStoredSession(parsed.data.sessionId);
        if (!stored) {
            throw RequestError.invalidParams(`Unknown sessionId: ${parsed.data.sessionId}`);
        }
        return { latestEntryId: await readPiLatestEntryId(stored.sessionFile) };
    }

    async steer(
        params: unknown,
        signal: AbortSignal,
    ): Promise<{ readonly outcome: "injected" } | { readonly outcome: "promptRequired"; readonly reason: string }> {
        signal.throwIfAborted();
        const parsed = steerRequestSchema.safeParse(params);
        if (!parsed.success) {
            throw RequestError.invalidParams("Invalid steering request");
        }
        const session = this.sessions.maybeGet(parsed.data.sessionId);
        if (session === undefined) {
            return { outcome: "promptRequired", reason: "noRunningTurn" };
        }
        const { message, images } = promptToPiMessage(parsed.data.prompt);
        const steering = await session.steer(message, images, signal);
        switch (steering.kind) {
            case "idle":
                return { outcome: "promptRequired", reason: "noRunningTurn" };
            case "injected": {
                return { outcome: "injected" };
            }
        }
    }

    async cancel(params: CancelNotification): Promise<void> {
        for (const submission of this.pendingSubmissions.get(params.sessionId) ?? []) {
            submission.abort();
        }
        const session = this.sessions.maybeGet(params.sessionId);
        if (!session) {
            return;
        }
        await session.cancel();
    }

    async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
        // ACP: filter by cwd if provided.
        // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
        // emulate pi's `/resume` picker (project-scoped).
        const all = listPiSessions(this.environment);

        const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd;
        const filtered = effectiveCwd ? all.filter((s) => s.cwd === effectiveCwd) : all;

        const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
        const start = Number.isFinite(offset) && offset > 0 ? offset : 0;

        const PAGE_SIZE = 50;
        const page = filtered.slice(start, start + PAGE_SIZE);

        const sessions: SessionInfo[] = page.map((s) => ({
            sessionId: s.sessionId,
            cwd: s.cwd,
            title: s.title,
            updatedAt: s.updatedAt,
        }));

        const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;

        return { sessions, nextCursor, _meta: {} };
    }

    async forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
        if (!isAbsolute(params.cwd)) {
            throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
        }

        const source = this.findStoredSession(params.sessionId);
        if (!source) {
            throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
        }

        this.lastSessionCwd = params.cwd;
        const fileCommands = loadSlashCommands(params.cwd, this.environment);
        const enableSkillCommands = getEnableSkillCommands(params.cwd, this.environment);
        const session = await this.sessions.create({
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            conn: this.conn,
            fileCommands,
            piCommand: this.environment.PI_ACP_PI_COMMAND,
            environment: this.environment,
            origin: { kind: "fork", sessionPath: source.sessionFile },
        });
        const proc = session.proc;
        let configuration: Awaited<ReturnType<typeof getSessionConfiguration>>;
        try {
            configuration = await getSessionConfiguration(proc);
        } catch (cause) {
            let state: unknown = null;
            try {
                state = await proc.getState();
            } catch {
                // The configuration failure remains the primary error.
            }
            this.cleanupFailedNewSession(session.sessionId, state);
            throw cause;
        }
        const { configOptions, modes } = configuration;

        this.sessions.closeAllExcept(session.sessionId);
        setTimeout(() => {
            void (async () => {
                await session.publishContextUsage();
                try {
                    const pi = await proc.getCommands();
                    const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
                        enableSkillCommands,
                        includeExtensionCommands: false,
                    });
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "available_commands_update",
                            availableCommands: mergeCommands(commands, builtinAvailableCommands()),
                        },
                    });
                    return;
                } catch {}
                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "available_commands_update",
                        availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands()),
                    },
                });
            })().catch(() => {
                // Session setup notifications are best-effort; the client or Pi process may close first.
            });
        }, 0);

        return { sessionId: session.sessionId, configOptions, modes };
    }

    async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
        if (!isAbsolute(params.cwd)) {
            throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
        }

        this.sessions.close(params.sessionId);
        this.lastSessionCwd = params.cwd;

        const stored = this.findStoredSession(params.sessionId);
        if (!stored) {
            throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
        }

        const session = await this.restoreSession(params.sessionId, {
            cwd: params.cwd,
            mcpServers: params.mcpServers,
        });
        let configuration: Awaited<ReturnType<typeof getSessionConfiguration>>;
        try {
            configuration = await getSessionConfiguration(session.proc);
        } catch (err) {
            this.sessions.close(session.sessionId);
            throw err;
        }
        const { configOptions, models, modes } = configuration;
        const enableSkillCommands = getEnableSkillCommands(params.cwd, this.environment);
        const fileCommands = loadSlashCommands(params.cwd, this.environment);

        (this.sessions as any).closeAllExcept?.(session.sessionId);
        this.store.upsert({
            sessionId: params.sessionId,
            cwd: params.cwd,
            sessionFile: stored.sessionFile,
        });

        const response = {
            configOptions,
            models,
            modes,
            _meta: {
                piAcp: {
                    startupInfo: null,
                },
            },
        };
        setTimeout(() => {
            void (async () => {
                await session.publishContextUsage();
                try {
                    const pi = (await session.proc.getCommands()) as any;
                    const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
                        enableSkillCommands,
                        includeExtensionCommands: false,
                    });
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "available_commands_update",
                            availableCommands: mergeCommands(commands, builtinAvailableCommands()),
                        },
                    });
                    return;
                } catch {}
                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "available_commands_update",
                        availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands()),
                    },
                });
            })().catch(() => {
                // Session setup notifications are best-effort; the client or Pi process may close first.
            });
        }, 0);
        return response;
    }

    async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        if (!isAbsolute(params.cwd)) {
            throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
        }

        // If the client is re-loading a session that is already active, tear down the existing
        // pi subprocess so we can start fresh and re-advertise commands reliably.
        // (Some clients may call session/load when restoring from history.)
        this.sessions.close(params.sessionId);

        this.lastSessionCwd = params.cwd;

        const stored = this.findStoredSession(params.sessionId);
        if (!stored) {
            throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`);
        }

        const enableSkillCommands = getEnableSkillCommands(params.cwd, this.environment);
        const session = await this.restoreSession(params.sessionId, {
            cwd: params.cwd,
            mcpServers: params.mcpServers,
        });
        const proc = session.proc;
        let configuration: Awaited<ReturnType<typeof getSessionConfiguration>>;
        try {
            configuration = await getSessionConfiguration(proc);
        } catch (err) {
            this.sessions.close(session.sessionId);
            throw err;
        }
        const { configOptions, models, modes } = configuration;
        const fileCommands = loadSlashCommands(params.cwd, this.environment);

        // Policy: within a single ACP connection (one Zed window), keep only one live pi subprocess.
        // (Tests sometimes stub out `this.sessions`, so guard the call.)
        (this.sessions as any).closeAllExcept?.(session.sessionId);

        // (Optional) ensure mapping stays fresh.
        this.store.upsert({
            sessionId: params.sessionId,
            cwd: params.cwd,
            sessionFile: stored.sessionFile,
        });

        // Native entries retain messages that get_messages removes on compaction.
        for (const entry of readPiHistory(stored.sessionFile)) {
            if (entry.type === "compaction") {
                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "compaction_update",
                        compactionId: entry.id,
                        status: "completed",
                    },
                });
                if (entry.summary) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "compaction_summary_chunk",
                            compactionId: entry.id,
                            content: { type: "text", text: entry.summary },
                        },
                    });
                }
                continue;
            }
            const m = entry.message;
            const role = String(m?.role ?? "");

            if (role === "user") {
                this.conn.startUserMessage();
                for (const content of piUserMessageContent(m.content)) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "user_message_chunk",
                            content,
                        },
                    });
                }
            }

            if (role === "assistant") {
                const text = normalizePiAssistantText(m?.content);
                if (text) {
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text },
                        },
                    });
                }
            }

            if (role === "toolResult") {
                const toolName = String((m as any)?.toolName ?? "tool");
                const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID());
                const isError = Boolean((m as any)?.isError);
                const isBash = isBashTool(toolName);

                if (isBash) {
                    const text = bashResultText(m);
                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "tool_call",
                            toolCallId,
                            title: bashCommand(m) ?? toolName,
                            kind: "execute",
                            status: "completed",
                            rawInput: null,
                        },
                    });

                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "tool_call_update",
                            toolCallId,
                            status: isError ? "failed" : "completed",
                            content: text ? [{ type: "content", content: { type: "text", text } }] : null,
                            rawOutput: m,
                        },
                    });
                    continue;
                }

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "tool_call",
                        toolCallId,
                        title: toolName,
                        kind:
                            toolName === "read"
                                ? "read"
                                : toolName === "write" || toolName === "edit"
                                  ? "edit"
                                  : "other",
                        status: "completed",
                        rawInput: null,
                        rawOutput: m,
                    },
                });

                const text = toolResultToText(m);
                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId,
                        status: isError ? "failed" : "completed",
                        content: text ? [{ type: "content", content: { type: "text", text } }] : null,
                        rawOutput: m,
                    },
                });
            }
        }

        const response = {
            configOptions,
            models,
            modes,
            _meta: {
                piAcp: {
                    startupInfo: null,
                },
            },
        };

        // Advertise slash commands after the response so the client knows the session exists.
        setTimeout(() => {
            void (async () => {
                await session.publishContextUsage();

                try {
                    const pi = (await proc.getCommands()) as any;
                    const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
                        enableSkillCommands,
                        includeExtensionCommands: false,
                    });

                    await this.conn.sessionUpdate({
                        sessionId: session.sessionId,
                        update: {
                            sessionUpdate: "available_commands_update",
                            availableCommands: mergeCommands(commands, builtinAvailableCommands()),
                        },
                    });
                    return;
                } catch {}

                await this.conn.sessionUpdate({
                    sessionId: session.sessionId,
                    update: {
                        sessionUpdate: "available_commands_update",
                        availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands()),
                    },
                });
            })().catch(() => {
                // Session setup notifications are best-effort; the client or Pi process may close first.
            });
        }, 0);

        return response;
    }

    async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
        const stored = this.store.get(params.sessionId);
        const piSession = findPiSession(params.sessionId, this.environment);

        // Per ACP session/delete semantics, deleting a session that does not
        // exist (or is already gone) should succeed idempotently.
        // https://agentclientprotocol.com/protocol/v2/session-delete#semantics
        if (!stored && !piSession) {
            return {};
        }

        const sessionFile = stored?.sessionFile ?? piSession?.sessionFile;

        if (sessionFile) {
            try {
                if (existsSync(sessionFile)) {
                    unlinkSync(sessionFile);
                }
            } catch {}
        }

        this.store.delete(params.sessionId);

        return {};
    }

    async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
        const session = await this.restoreSession(params.sessionId);
        await setSessionModel(session.proc, params.modelId);
        await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
        await session.publishContextUsage();
    }

    async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
        const session = await this.restoreSession(params.sessionId);

        const mode = params.modeId;
        if (typeof mode !== "string" || mode.length === 0) {
            throw RequestError.invalidParams("Expected nonempty string modeId");
        }

        await session.proc.setThinkingLevel(mode);

        await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);

        return {};
    }

    async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
        const session = await this.restoreSession(params.sessionId);
        const configId = String(params.configId);
        let modelChanged = false;

        if (typeof params.value !== "string") {
            throw RequestError.invalidParams(`Expected string value for config option: ${configId}`);
        }

        if (configId === MODEL_CONFIG_ID) {
            await setSessionModel(session.proc, params.value);
            modelChanged = true;
        } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
            if (params.value.length === 0) {
                throw RequestError.invalidParams("Expected nonempty thinking level");
            }

            await session.proc.setThinkingLevel(params.value);
        } else {
            throw RequestError.invalidParams(`Unknown config option: ${configId}`);
        }

        const configOptions = await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
        // A different model can mean a different context window; refresh it immediately.
        if (modelChanged) {
            await session.publishContextUsage();
        }
        return { configOptions };
    }
}

async function getThinkingState(
    proc: PiRpcProcess,
    pre?: { state?: any | null },
): Promise<{
    availableModes: Array<{
        id: string;
        name: string;
        description?: string | null;
    }>;
    currentModeId: string;
}> {
    const state = pre?.state ?? (await proc.getState());
    const available = await proc.getAvailableThinkingLevels();
    const current: unknown =
        state && typeof state === "object" && "thinkingLevel" in state ? state.thinkingLevel : undefined;
    if (typeof current !== "string" || current.length === 0 || !available.includes(current)) {
        throw new Error("pi returned a thinking level absent from available levels");
    }

    return {
        currentModeId: current,
        availableModes: available.map((id) => ({
            id,
            name: `Thinking: ${thinkingLevelName(id)}`,
            description: null,
        })),
    };
}

async function getSessionConfiguration(
    proc: PiRpcProcess,
    pre?: { state?: any | null; availableModels?: any | null },
): Promise<{
    configOptions: SessionConfigOption[];
    models: {
        availableModels: AdvertisedModel[];
        currentModelId: string;
    } | null;
    modes: {
        availableModes: Array<{
            id: string;
            name: string;
            description?: string | null;
        }>;
        currentModeId: string;
    };
}> {
    const state = pre?.state ?? (await proc.getState());
    const [models, modes] = await Promise.all([
        getModelState(proc, { ...pre, state }),
        getThinkingState(proc, { state }),
    ]);

    return {
        configOptions: buildConfigOptions({ models, modes }),
        models,
        modes,
    };
}

function buildConfigOptions(state: {
    models: {
        availableModels: AdvertisedModel[];
        currentModelId: string;
    } | null;
    modes: {
        availableModes: Array<{
            id: string;
            name: string;
            description?: string | null;
        }>;
        currentModeId: string;
    };
}): SessionConfigOption[] {
    const configOptions: SessionConfigOption[] = [];
    if (state.modes.availableModes.length > 1) {
        configOptions.push({
            type: "select",
            id: THOUGHT_LEVEL_CONFIG_ID,
            category: "thought_level",
            name: "Thinking",
            description: "Set the reasoning effort for this session",
            currentValue: state.modes.currentModeId,
            options: state.modes.availableModes.map((mode) => ({
                value: mode.id,
                name: thinkingLevelName(mode.id),
                description: mode.description ?? null,
            })),
        });
    }

    if (state.models?.availableModels.length) {
        configOptions.unshift({
            type: "select",
            id: MODEL_CONFIG_ID,
            category: "model",
            name: "Model",
            description: "Select the model for this session",
            currentValue: state.models.currentModelId,
            options: state.models.availableModels.map((model) => ({
                value: model.modelId,
                name: model.name,
                description: model.description ?? null,
            })),
        });
    }

    return configOptions;
}

async function getModelState(
    proc: PiRpcProcess,
    pre?: { state?: any | null; availableModels?: any | null },
): Promise<{
    availableModels: AdvertisedModel[];
    currentModelId: string;
} | null> {
    let availableModels: AdvertisedModel[] = [];

    const data =
        pre?.availableModels ??
        (await (async () => {
            try {
                return (await proc.getAvailableModels()) as any;
            } catch {
                return null;
            }
        })());

    const models: any[] = Array.isArray(data?.models) ? data.models : [];
    availableModels = models
        .map((m) => {
            const provider = String(m?.provider ?? "").trim();
            const id = String(m?.id ?? "").trim();
            if (!provider || !id) {
                return null;
            }

            const name = String(m?.name ?? id);
            return {
                modelId: `${provider}/${id}`,
                name: `${provider}/${name}`,
                description: null,
            } satisfies AdvertisedModel;
        })
        .filter(Boolean) as AdvertisedModel[];

    let currentModelId: string | null = null;

    const state =
        pre?.state ??
        (await (async () => {
            try {
                return (await proc.getState()) as any;
            } catch {
                return null;
            }
        })());

    const model = state?.model;
    if (model && typeof model === "object") {
        const provider = String((model as any).provider ?? "").trim();
        const id = String((model as any).id ?? "").trim();
        if (provider && id) {
            currentModelId = `${provider}/${id}`;
        }
    }

    if (!availableModels.length && !currentModelId) {
        return null;
    }

    if (!currentModelId) {
        currentModelId = availableModels[0]?.modelId ?? "default";
    }

    return {
        availableModels,
        currentModelId: currentModelId ?? availableModels[0]?.modelId ?? "default",
    };
}

async function emitConfigOptionsUpdate(
    conn: PiAcpClient,
    sessionId: string,
    proc: PiRpcProcess,
): Promise<SessionConfigOption[]> {
    const { configOptions, modes } = await getSessionConfiguration(proc);

    await conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: modes.currentModeId },
    });
    await conn.sessionUpdate({
        sessionId,
        update: {
            sessionUpdate: "config_option_update",
            configOptions,
        },
    });

    return configOptions;
}

async function setSessionModel(proc: PiRpcProcess, requestedModelId: string): Promise<void> {
    let provider: string | null = null;
    let modelId: string | null = null;

    if (requestedModelId.includes("/")) {
        const [candidateProvider, ...rest] = requestedModelId.split("/");
        provider = candidateProvider;
        modelId = rest.join("/");
    } else {
        modelId = requestedModelId;
    }

    if (!provider) {
        const data = (await proc.getAvailableModels()) as any;
        const models: any[] = Array.isArray(data?.models) ? data.models : [];
        const found = models.find((m) => String(m?.id) === modelId);
        if (found) {
            provider = String(found.provider);
            modelId = String(found.id);
        }
    }

    if (!provider || !modelId) {
        throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`);
    }

    await proc.setModel(provider, modelId);
}

function isSemver(v: string): boolean {
    return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}

function compareSemver(a: string, b: string): number {
    const pa = a
        .split(/[.-]/)
        .slice(0, 3)
        .map((n) => Number(n));
    const pb = b
        .split(/[.-]/)
        .slice(0, 3)
        .map((n) => Number(n));
    for (let i = 0; i < 3; i++) {
        const da = pa[i] ?? 0;
        const db = pb[i] ?? 0;
        if (da > db) {
            return 1;
        }
        if (da < db) {
            return -1;
        }
    }
    return 0;
}

function buildUpdateNotice(): string | null {
    // Best-effort update check against npm registry.
    // Important: keep it fast to not slow down session/new.
    try {
        const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
        const installed = (String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()).replace(
            /^v/i,
            "",
        );

        if (!installed || !isSemver(installed)) {
            return null;
        }

        const latestRes = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent", "version"], {
            encoding: "utf-8",
            timeout: 800,
        });
        const latest = String(latestRes.stdout ?? "")
            .trim()
            .replace(/^v/i, "");

        if (!latest || !isSemver(latest)) {
            return null;
        }
        if (compareSemver(latest, installed) <= 0) {
            return null;
        }

        return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
    } catch {
        return null;
    }
}

function buildStartupInfo(opts: {
    cwd: string;
    environment: Readonly<NodeJS.ProcessEnv>;
    fileCommands: ReturnType<typeof loadSlashCommands>;
    updateNotice: string | null;
}): string {
    void opts.fileCommands;

    const md: string[] = [];

    try {
        const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
        const installed = (String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()).replace(
            /^v/i,
            "",
        );
        if (installed) {
            md.push(`pi v${installed}`);
            md.push("---");
            md.push("");
        }
    } catch {}

    const addSection = (title: string, items: string[]) => {
        const cleaned = items.map((s) => s.trim()).filter(Boolean);
        if (!cleaned.length) {
            return;
        }

        md.push(`## ${title}`);
        for (const item of cleaned) {
            md.push(`- ${item}`);
        }
        md.push("");
    };

    const contextItems: string[] = [];
    const contextPath = join(opts.cwd, "AGENTS.md");
    if (existsSync(contextPath)) {
        contextItems.push(contextPath);
    }
    addSection("Context", contextItems);

    const skillsItems: string[] = [];

    const pushSkillFromRoot = (root: string) => {
        try {
            for (const e of readdirSync(root)) {
                const p = join(root, e);
                try {
                    const st = statSync(p);
                    if (st.isFile() && e.toLowerCase().endsWith(".md")) {
                        skillsItems.push(p);
                    }
                } catch {}
            }

            const stack: string[] = [root];
            while (stack.length) {
                const dir = stack.pop();
                if (dir === undefined) {
                    break;
                }
                let entries: string[] = [];
                try {
                    entries = readdirSync(dir);
                } catch {
                    continue;
                }

                for (const name of entries) {
                    if (name === "node_modules" || name === ".git") {
                        continue;
                    }
                    const p = join(dir, name);
                    let st: ReturnType<typeof statSync>;
                    try {
                        st = statSync(p);
                    } catch {
                        continue;
                    }
                    if (st.isDirectory()) {
                        stack.push(p);
                    } else if (st.isFile() && name === "SKILL.md") {
                        skillsItems.push(p);
                    }
                }
            }
        } catch {}
    };

    // Global skills
    // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
    const globalSkillsDir = join(getAgentDir(opts.environment), "skills");
    pushSkillFromRoot(globalSkillsDir);

    const home = opts.environment["HOME"] ?? opts.environment["USERPROFILE"] ?? "";
    const legacyAgentsSkillsDir = join(home, ".agents", "skills");
    pushSkillFromRoot(legacyAgentsSkillsDir);

    const projectSkillsDir = join(opts.cwd, ".pi", "skills");
    pushSkillFromRoot(projectSkillsDir);

    addSection("Skills", skillsItems);

    const promptsItems: string[] = [];
    const promptsDir = join(home, ".pi", "agent", "prompts");
    try {
        const prompts = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
        for (const f of prompts) {
            promptsItems.push(`/${basename(f, ".md")}`);
        }
    } catch {}
    addSection("Prompts", promptsItems);

    const extItems: string[] = [];
    const extDir = join(home, ".pi", "agent", "extensions");
    try {
        const exts = readdirSync(extDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
        for (const f of exts) {
            extItems.push(join(extDir, f));
        }
    } catch {}

    const settingsPaths = [
        join(getAgentDir(opts.environment), "settings.json"),
        join(opts.cwd, ".pi", "settings.json"),
    ];
    for (const settingsPath of settingsPaths) {
        try {
            const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as any;
            const pkgs: string[] = Array.isArray(settings?.packages) ? settings.packages : [];
            for (const pkg of pkgs) {
                const s = String(pkg);
                if (s.startsWith("npm:")) {
                    extItems.push(`${s}\n  - index.ts`);
                } else {
                    extItems.push(s);
                }
            }
        } catch {}
    }

    addSection("Extensions", extItems);

    if (opts.updateNotice) {
        md.push("---");
        md.push(opts.updateNotice);
        md.push("");
    }

    // Do NOT include themes (per request).
    return `${md.join("\n").trim()}\n`;
}
