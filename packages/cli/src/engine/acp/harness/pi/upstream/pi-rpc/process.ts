import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import { getPiCommand, shouldUseShellForPiCommand } from "./command.js";

export class PiRpcSpawnError extends Error {
    code?: string;

    constructor(message: string, opts?: { code?: string; cause?: unknown }) {
        super(message);
        this.name = "PiRpcSpawnError";
        this.code = opts?.code;
        (this as any).cause = opts?.cause;
    }
}

export class PiRpcProcessError extends Error {
    readonly code = "pi_process_exited";

    constructor(cause: unknown) {
        super("Pi process stopped unexpectedly.", { cause });
        this.name = "PiRpcProcessError";
    }
}

export class PiRpcTeardownError extends Error {
    readonly code = "pi_process_teardown_timeout";

    constructor() {
        super("Pi process output did not close after termination.");
        this.name = "PiRpcTeardownError";
    }
}

export interface PiProcessHost {
    readonly spawn: (
        command: string,
        args: readonly string[],
        options: {
            readonly cwd: string;
            readonly environment: Readonly<NodeJS.ProcessEnv>;
            readonly shell: boolean;
        },
    ) => ChildProcessWithoutNullStreams;
    readonly stop: (child: ChildProcessWithoutNullStreams) => Promise<void>;
}

const PIPE_CLOSE_TIMEOUT_MS = 5_000;

const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);

const ANSI_ESCAPE_REGEX = new RegExp(
    `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
    "g",
);

function stripAnsi(s: string): string {
    return s.replace(ANSI_ESCAPE_REGEX, "");
}

type PiRpcCommand =
    | { type: "prompt"; id?: string; message: string; images?: unknown[] }
    | { type: "steer"; id?: string; message: string; images?: unknown[] }
    | { type: "abort"; id?: string }
    | { type: "get_state"; id?: string }
    | { type: "get_available_models"; id?: string }
    | { type: "set_model"; id?: string; provider: string; modelId: string }
    | { type: "get_available_thinking_levels"; id?: string }
    | { type: "set_thinking_level"; id?: string; level: string }
    | { type: "set_follow_up_mode"; id?: string; mode: "all" | "one-at-a-time" }
    | { type: "set_steering_mode"; id?: string; mode: "all" | "one-at-a-time" }
    | { type: "compact"; id?: string; customInstructions?: string }
    | { type: "set_auto_compaction"; id?: string; enabled: boolean }
    | { type: "get_session_stats"; id?: string }
    | { type: "set_session_name"; id?: string; name: string }
    | { type: "export_html"; id?: string; outputPath?: string }
    | { type: "switch_session"; id?: string; sessionPath: string }
    | { type: "get_messages"; id?: string }
    | { type: "get_commands"; id?: string };

type PiRpcResponse = {
    type: "response";
    id?: string;
    command: string;
    success: boolean;
    data?: unknown;
    error?: string;
};

type PiExtensionUiResponse =
    | { id: string; value: string }
    | { id: string; confirmed: boolean }
    | { id: string; cancelled: true };

export type PiRpcEvent = Record<string, unknown>;

export const SESSION_STATS_TIMEOUT_MS = 1_000;

export type PiContextUsage = {
    tokens?: number | null;
    contextWindow?: number | null;
};

export type PiSessionStats = {
    sessionId?: string;
    sessionFile?: string;
    totalMessages?: number;
    cost?: number;
    tokens?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
    };
    contextUsage?: PiContextUsage | null;
};

export type PiSessionOrigin =
    | { readonly kind: "new" }
    | { readonly kind: "load"; readonly sessionPath: string }
    | { readonly kind: "fork"; readonly sessionPath: string };

type SpawnParams = {
    readonly processes: PiProcessHost;
    readonly signal?: AbortSignal;
    readonly cwd: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly piCommand?: string;
    readonly origin: PiSessionOrigin;
};

export class PiRpcProcess {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly lifetime = new AbortController();
    private readonly exited = Promise.withResolvers<void>();
    private closing: Promise<void> | null = null;
    private removeAbortListener: () => void = () => undefined;
    private readonly lines: readline.Interface;

    get signal(): AbortSignal {
        return this.lifetime.signal;
    }
    private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>();
    private eventHandlers: Array<(ev: PiRpcEvent) => void> = [];
    private readonly preludeLines: string[] = [];

    private constructor(
        child: ChildProcessWithoutNullStreams,
        private readonly processes: PiProcessHost,
    ) {
        this.child = child;
        this.child.stdin.on("error", () => {
            // Pending RPC promises receive the process error below. Keep a closed stdin from also
            // surfacing as an uncaught EPIPE while the owning endpoint is being released.
        });

        const rl = readline.createInterface({ input: child.stdout });
        this.lines = rl;
        rl.on("line", (line) => {
            if (!line.trim()) {
                return;
            }
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                // pi may emit a human-readable prelude on stdout before NDJSON starts.
                // Capture it so the ACP adapter can surface it on session start.
                const cleaned = stripAnsi(String(line)).trimEnd();
                if (cleaned) {
                    this.preludeLines.push(cleaned);
                }
                return;
            }

            if (msg?.type === "response") {
                const id = typeof msg.id === "string" ? msg.id : undefined;
                // `resolve` removes the pending entry. Responses for unknown or already timed-out
                // ids are dropped: a response is never a pi event, so it must not be broadcast.
                if (id !== undefined) {
                    this.pending.get(id)?.resolve(msg as PiRpcResponse);
                }
                return;
            }

            for (const h of this.eventHandlers) {
                h(msg as PiRpcEvent);
            }
        });

        child.on("exit", (code, signal) => {
            const err = new PiRpcProcessError({ code, signal });
            this.lifetime.abort(err);
            for (const [, p] of this.pending) {
                p.reject(err);
            }
            this.pending.clear();
        });
        child.once("close", () => {
            this.removeAbortListener();
            this.exited.resolve();
        });

        child.on("error", (cause) => {
            const err = new PiRpcProcessError(cause);
            this.lifetime.abort(err);
            for (const [, p] of this.pending) {
                p.reject(err);
            }
            this.pending.clear();
        });
    }

    static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
        params.signal?.throwIfAborted();
        // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
        const cmd = getPiCommand(params.piCommand);

        // Speed/robustness for ACP:
        // - themes are irrelevant in rpc mode and can be noisy/slow to load.
        // Keep extensions + prompt templates enabled because ACP users may rely on them
        // (e.g. MCP extensions, prompt templates for workflows).
        const args = ["--mode", "rpc", "--no-themes"];
        const sessionDirectory = params.environment["MORTY_PI_SESSION_DIR"];
        if (sessionDirectory !== undefined && sessionDirectory.trim().length > 0) {
            // The flag predates the equivalent environment variable, so pass both: the
            // flag configures older Pi versions while the variable identifies the same
            // directory to Morty's native-session discovery.
            args.push("--session-dir", sessionDirectory);
        }
        switch (params.origin.kind) {
            case "new":
                break;
            case "load":
                args.push("--session", params.origin.sessionPath);
                break;
            case "fork":
                args.push("--fork", params.origin.sessionPath);
                break;
        }

        // Windows cmd launchers need shell escaping; direct executables use native argv.
        const child = params.processes.spawn(cmd, args, {
            cwd: params.cwd,
            environment: params.environment,
            shell: shouldUseShellForPiCommand(cmd),
        });
        const proc = new PiRpcProcess(child, params.processes);
        // Native spawn cancellation kills only the launcher. Capture and stop its tree instead.
        if (params.signal !== undefined) {
            const signal = params.signal;
            const abort = (): void => {
                void proc.dispose().catch(() => undefined);
            };
            signal.addEventListener("abort", abort, { once: true });
            proc.removeAbortListener = () => signal.removeEventListener("abort", abort);
            if (signal.aborted) {
                abort();
            }
        }

        // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
        // deterministic error instead of later EPIPE/internal-error noise.
        try {
            await new Promise<void>((resolve, reject) => {
                const onSpawn = () => {
                    cleanup();
                    resolve();
                };
                const onError = (err: any) => {
                    cleanup();
                    reject(err);
                };
                const cleanup = () => {
                    child.off("spawn", onSpawn);
                    child.off("error", onError);
                };

                child.once("spawn", onSpawn);
                child.once("error", onError);
            });
        } catch (e: any) {
            await proc.dispose();
            params.signal?.throwIfAborted();
            const code = typeof e?.code === "string" ? e.code : undefined;
            if (code === "ENOENT") {
                throw new PiRpcSpawnError(
                    `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
                    { code, cause: e },
                );
            }

            if (code === "EACCES") {
                throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, {
                    code,
                    cause: e,
                });
            }

            throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e });
        }

        child.stderr.on("data", () => {
            // leave stderr untouched; ACP clients may capture it.
        });

        // Best-effort handshake.
        // Important: pi may emit a get_state response pointing at a sessionFile in a directory
        // that is created lazily. Create the parent dir up-front to avoid later parse errors
        // when we call commands like export_html.
        try {
            const state = (await proc.getState()) as any;
            const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
            if (sessionFile) {
                const { mkdirSync } = await import("node:fs");
                const { dirname } = await import("node:path");
                mkdirSync(dirname(sessionFile), { recursive: true });
            }
        } catch {}

        if (params.signal?.aborted) {
            await proc.dispose();
            params.signal.throwIfAborted();
        }
        return proc;
    }

    onEvent(handler: (ev: PiRpcEvent) => void): () => void {
        this.eventHandlers.push(handler);
        return () => {
            this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
        };
    }

    dispose(): Promise<void> {
        if (this.closing !== null) {
            return this.closing;
        }
        this.lifetime.abort();
        this.closing = (async () => {
            try {
                await this.processes.stop(this.child);
                // A descendant can retain inherited pipes even after the launcher exits.
                let timeout: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        this.exited.promise,
                        new Promise<never>((_resolve, reject) => {
                            timeout = setTimeout(() => reject(new PiRpcTeardownError()), PIPE_CLOSE_TIMEOUT_MS);
                            timeout.unref();
                        }),
                    ]);
                } finally {
                    clearTimeout(timeout);
                }
            } finally {
                this.removeAbortListener();
                this.lines.close();
                this.child.stdin.destroy();
                this.child.stdout.destroy();
                this.child.stderr.destroy();
            }
        })();
        return this.closing;
    }

    terminateAfterFailure(cause: unknown): void {
        this.lifetime.abort(new PiRpcProcessError(cause));
        void this.dispose().catch(() => undefined);
    }

    /**
     * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
     * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
     */
    consumePreludeLines(): string[] {
        const lines = this.preludeLines.splice(0, this.preludeLines.length);
        return lines;
    }

    async prompt(message: string, images: unknown[] = []): Promise<void> {
        const res = await this.request({ type: "prompt", message, images });
        if (!res.success) {
            throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
    }

    async steer(message: string, images: unknown[], signal: AbortSignal): Promise<void> {
        const res = await this.request({ type: "steer", message, images }, { signal });
        if (!res.success) {
            throw new Error(`pi steer failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
    }

    async abort(opts?: { readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<void> {
        const res = await this.request({ type: "abort" }, opts);
        if (!res.success) {
            throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
    }

    async getState(): Promise<unknown> {
        const res = await this.request({ type: "get_state" });
        if (!res.success) {
            throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
        return res.data;
    }

    async getAvailableModels(): Promise<unknown> {
        const res = await this.request({ type: "get_available_models" });
        if (!res.success) {
            throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
        return res.data;
    }

    async setModel(provider: string, modelId: string): Promise<unknown> {
        const res = await this.request({ type: "set_model", provider, modelId });
        if (!res.success) {
            throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
        return res.data;
    }

    async getAvailableThinkingLevels(): Promise<string[]> {
        const res = await this.request({ type: "get_available_thinking_levels" });
        if (!res.success) {
            throw new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
        const data = res.data;
        const levels = data && typeof data === "object" && "levels" in data ? data.levels : undefined;
        if (
            !Array.isArray(levels) ||
            levels.length === 0 ||
            !levels.every((level) => typeof level === "string" && level.length > 0)
        ) {
            throw new Error("pi get_available_thinking_levels returned invalid levels");
        }
        return levels;
    }

    async setThinkingLevel(level: string): Promise<void> {
        const res = await this.request({ type: "set_thinking_level", level });
        if (!res.success) {
            throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
    }

    async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
        const res = await this.request({ type: "set_follow_up_mode", mode });
        if (!res.success) {
            throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
    }

    async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
        const res = await this.request({ type: "set_steering_mode", mode });
        if (!res.success) {
            throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
    }

    async compact(customInstructions?: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
        const res = await this.request({ type: "compact", customInstructions }, opts);
        if (!res.success) {
            throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
        return res.data;
    }

    async setAutoCompaction(enabled: boolean): Promise<void> {
        const res = await this.request({ type: "set_auto_compaction", enabled });
        if (!res.success) {
            throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
    }

    async getSessionStats(timeoutMs?: number): Promise<PiSessionStats> {
        const res = await this.request({ type: "get_session_stats" }, { timeoutMs });
        if (!res.success) {
            throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
        return (res.data ?? {}) as PiSessionStats;
    }

    async setSessionName(name: string): Promise<void> {
        const res = await this.request({ type: "set_session_name", name });
        if (!res.success) {
            throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
    }

    async exportHtml(outputPath?: string): Promise<{ path: string }> {
        const res = await this.request({ type: "export_html", outputPath });
        if (!res.success) {
            throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
        const data: any = res.data;
        return { path: String(data?.path ?? "") };
    }

    async switchSession(sessionPath: string): Promise<void> {
        const res = await this.request({ type: "switch_session", sessionPath });
        if (!res.success) {
            throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
    }

    async getMessages(): Promise<unknown> {
        const res = await this.request({ type: "get_messages" });
        if (!res.success) {
            throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
        return res.data;
    }

    async getCommands(): Promise<unknown> {
        const res = await this.request({ type: "get_commands" });
        if (!res.success) {
            throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`);
        }
        return res.data;
    }

    async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
        await this.writeLine(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
    }

    private request(cmd: PiRpcCommand, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<PiRpcResponse> {
        const id = crypto.randomUUID();
        const withId = { ...cmd, id };
        const timeoutMs = opts?.timeoutMs;

        const line = `${JSON.stringify(withId)}\n`;

        return new Promise<PiRpcResponse>((resolve, reject) => {
            const signal = opts?.signal === undefined ? this.signal : AbortSignal.any([this.signal, opts.signal]);
            if (signal?.aborted === true) {
                reject(signal.reason);
                return;
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            let abort: (() => void) | undefined;

            // Returns false when the id was already dropped (e.g. by the timeout), so the
            // caller can avoid settling the promise twice.
            const drop = (): boolean => {
                if (timer !== undefined) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                if (abort !== undefined) {
                    signal?.removeEventListener("abort", abort);
                    abort = undefined;
                }
                return this.pending.delete(id);
            };

            this.pending.set(id, {
                resolve: (res) => {
                    drop();
                    resolve(res);
                },
                reject: (error) => {
                    drop();
                    reject(error);
                },
            });

            abort = () => {
                if (!drop()) {
                    return;
                }
                reject(signal?.reason);
            };
            signal?.addEventListener("abort", abort, { once: true });

            if (timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    timer = undefined;
                    if (!drop()) {
                        return;
                    }
                    reject(new Error(`pi ${cmd.type} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                // Never let an auxiliary request keep the event loop alive.
                timer.unref?.();
            }

            void this.writeLine(line).catch((error) => {
                if (!drop()) {
                    return;
                }
                reject(error);
            });
        });
    }

    private writeLine(line: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            try {
                this.child.stdin.write(line, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    resolve();
                });
            } catch (error: unknown) {
                reject(error);
            }
        });
    }
}
