import type { ChildProcess } from "node:child_process";

import { executableLaunch, platformSpawnOptions, spawnProcess } from "../../../util/process/executable.ts";

import { AcpExecutionError } from "../../acp-error.ts";
import { type AgentTermination, agentTerminationError } from "../../agent/agent-lifecycle.ts";
import { decodeAppServerMessage } from "./app-server-protocol.ts";
import { type OversizedMessage, OversizedMessageScanner } from "./oversized-message.ts";

const INITIALIZE_TIMEOUT_MILLISECONDS = 30_000;
const MESSAGE_OUTPUT_LIMIT_BYTES = 32 * 1_024 * 1_024;

export class CodexAppServerError extends AcpExecutionError {
    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options, code);
        this.name = "CodexAppServerError";
    }
}

export class CodexAppServerResponseTooLargeError extends CodexAppServerError {
    constructor() {
        super("codex_app_server_response_too_large", "The Codex app-server response is too large for Morty to read");
        this.name = "CodexAppServerResponseTooLargeError";
    }
}

type OutputLine =
    | { readonly kind: "reading"; readonly fragments: readonly string[]; readonly bytes: number }
    | { readonly kind: "discarding"; readonly scanner: OversizedMessageScanner };

const EMPTY_LINE: OutputLine = { kind: "reading", fragments: [], bytes: 0 };

/** A request the app-server addressed to Morty, which Morty must answer by id. */
export interface CodexAppServerServerRequest {
    readonly id: number | string;
    readonly method: string;
    readonly params: unknown;
}

export interface CodexAppServerHandlers {
    readonly onNotification: (method: string, params: unknown) => Promise<void>;
    readonly onServerRequest: (request: CodexAppServerServerRequest) => Promise<void>;
}

interface PendingRequest {
    readonly completion: PromiseWithResolvers<unknown>;
}

export interface CodexAppServerOptions {
    readonly command: string;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly handlers: CodexAppServerHandlers;
}

export class CodexAppServerClient {
    readonly #child: ChildProcess;
    readonly #handlers: CodexAppServerHandlers;
    readonly #pending = new Map<number | string, PendingRequest>();
    readonly #termination = Promise.withResolvers<AgentTermination>();
    readonly terminated = this.#termination.promise;
    #lifecycle: { readonly kind: "open" } | { readonly kind: "terminated"; readonly result: AgentTermination } = {
        kind: "open",
    };
    #nextRequestId = 1;
    #line: OutputLine = EMPTY_LINE;

    constructor(options: CodexAppServerOptions) {
        this.#handlers = options.handlers;
        const launch = executableLaunch(options.command, ["app-server"]);
        this.#child = spawnProcess(launch.command, launch.arguments, {
            cwd: options.cwd,
            ...platformSpawnOptions,
            env: { ...process.env, ...options.environment },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdin = this.#child.stdin;
        const stdout = this.#child.stdout;
        const stderr = this.#child.stderr;
        if (stdin === null || stdout === null || stderr === null) {
            this.#child.kill("SIGKILL");
            throw new CodexAppServerError("codex_app_server_unavailable", "The Codex app-server is unavailable");
        }
        stdout.setEncoding("utf8");
        stdout.on("data", (chunk: string) => {
            this.#consume(chunk);
        });
        stderr.setEncoding("utf8");
        stderr.on("data", (chunk: string) => {
            process.stderr.write(`[codex-app-server] ${chunk}`);
        });
        this.#child.once("error", (cause) => {
            this.#fail(
                new CodexAppServerError("codex_app_server_exited", "The Codex app-server could not run", { cause }),
            );
        });
        this.#child.once("exit", (code, signal) => {
            this.#fail(
                new CodexAppServerError("codex_app_server_exited", "The Codex app-server stopped", {
                    cause: { code, signal },
                }),
            );
        });
        for (const stream of [stdin, stdout, stderr]) {
            stream.on("error", (cause: Error) => {
                this.#fail(
                    new CodexAppServerError("codex_app_server_io_error", "The Codex app-server connection failed", {
                        cause,
                    }),
                );
            });
        }
        stdout.once("end", () => {
            this.#fail(new CodexAppServerError("codex_app_server_exited", "The Codex app-server output closed"));
        });
    }

    readonly child = (): ChildProcess => this.#child;

    readonly #fail = (error: CodexAppServerError): void => {
        this.#terminate({ kind: "failed", error });
    };

    readonly #terminate = (result: AgentTermination): void => {
        if (this.#lifecycle.kind === "terminated") {
            return;
        }
        this.#lifecycle = { kind: "terminated", result };
        this.#termination.resolve(result);
        const error = agentTerminationError(result);
        for (const [id, pending] of this.#pending) {
            this.#pending.delete(id);
            pending.completion.reject(error);
        }
    };

    readonly #requireOpen = (): void => {
        if (this.#lifecycle.kind === "terminated") {
            throw agentTerminationError(this.#lifecycle.result);
        }
    };

    readonly #consume = (chunk: string): void => {
        if (this.#lifecycle.kind === "terminated") {
            return;
        }
        try {
            let cursor = 0;
            while (cursor < chunk.length) {
                const newline = chunk.indexOf("\n", cursor);
                const end = newline < 0 ? chunk.length : newline;
                this.#read(chunk.slice(cursor, end), newline >= 0);
                cursor = end + 1;
            }
        } catch (error) {
            this.#fail(
                error instanceof CodexAppServerError
                    ? error
                    : new CodexAppServerError(
                          "codex_app_server_protocol_error",
                          "The Codex app-server sent an unreadable message",
                          { cause: error },
                      ),
            );
        }
    };

    readonly #read = (fragment: string, lineEnded: boolean): void => {
        const line = this.#line;
        if (line.kind === "discarding") {
            line.scanner.scan(fragment);
            if (lineEnded) {
                this.#line = EMPTY_LINE;
                this.#settleOversized(line.scanner.message());
            }
            return;
        }
        const fragments = [...line.fragments, fragment];
        const bytes = line.bytes + Buffer.byteLength(fragment);
        if (bytes > MESSAGE_OUTPUT_LIMIT_BYTES) {
            const scanner = new OversizedMessageScanner();
            for (const part of fragments) {
                scanner.scan(part);
            }
            this.#line = { kind: "discarding", scanner };
            this.#read("", lineEnded);
            return;
        }
        if (!lineEnded) {
            this.#line = { kind: "reading", fragments, bytes };
            return;
        }
        this.#line = EMPTY_LINE;
        const text = fragments.join("");
        if (text.trim().length === 0) {
            return;
        }
        const value: unknown = JSON.parse(text);
        this.#dispatch(decodeAppServerMessage(value));
    };

    // An oversized response fails only the request it answers. Any other oversized message stays
    // terminal: dropping a notification or an approval request would leave the Session inconsistent.
    readonly #settleOversized = (message: OversizedMessage): void => {
        if (message.kind === "other") {
            throw new CodexAppServerError(
                "codex_app_server_output_limit",
                "The Codex app-server produced an oversized message",
            );
        }
        const pending = this.#pending.get(message.id);
        if (pending === undefined) {
            return;
        }
        this.#pending.delete(message.id);
        pending.completion.reject(new CodexAppServerResponseTooLargeError());
    };

    // Handler failures are recorded as the app-server's terminal failure: an ACP client that cannot
    // accept an update or answer an approval has no way to resume the conversation.
    readonly #runHandler = (operation: Promise<void>): void => {
        void operation.catch((error: unknown) => {
            this.#fail(
                error instanceof CodexAppServerError
                    ? error
                    : new CodexAppServerError(
                          "codex_app_server_client_error",
                          "Morty could not process a Codex app-server message",
                          { cause: error },
                      ),
            );
        });
    };

    readonly #dispatch = (message: ReturnType<typeof decodeAppServerMessage>): void => {
        if (message.kind === "result-response") {
            const pending = this.#pending.get(message.id);
            if (pending === undefined) {
                return;
            }
            this.#pending.delete(message.id);
            pending.completion.resolve(message.result);
            return;
        }
        if (message.kind === "error-response") {
            const pending = this.#pending.get(message.id);
            if (pending === undefined) {
                return;
            }
            this.#pending.delete(message.id);
            pending.completion.reject(
                new CodexAppServerError("codex_app_server_request_failed", message.message, {
                    cause: { code: message.code },
                }),
            );
            return;
        }
        if (message.kind === "server-request") {
            this.#runHandler(
                this.#handlers.onServerRequest({ id: message.id, method: message.method, params: message.params }),
            );
            return;
        }
        this.#runHandler(this.#handlers.onNotification(message.method, message.params));
    };

    readonly request = async (method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
        signal.throwIfAborted();
        this.#requireOpen();
        const id = this.#nextRequestId;
        this.#nextRequestId += 1;
        const completion = Promise.withResolvers<unknown>();
        this.#pending.set(id, { completion });
        const abort = (): void => {
            if (this.#pending.delete(id)) {
                completion.reject(signal.reason ?? new Error("Codex app-server request was cancelled"));
            }
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            this.#write({ id, method, params });
            return await completion.promise;
        } finally {
            signal.removeEventListener("abort", abort);
            this.#pending.delete(id);
        }
    };

    readonly notify = (method: string, params: unknown): void => {
        this.#write({ method, params });
    };

    readonly respond = (id: number | string, result: unknown): void => {
        this.#write({ id, result });
    };

    readonly respondWithError = (id: number | string, code: number, message: string): void => {
        this.#write({ error: { code, message }, id });
    };

    readonly #write = (message: unknown): void => {
        this.#requireOpen();
        const stdin = this.#child.stdin;
        if (stdin === null || stdin.destroyed) {
            const error = new CodexAppServerError("codex_app_server_io_error", "The Codex app-server input is closed");
            this.#fail(error);
            throw error;
        }
        stdin.write(`${JSON.stringify(message)}\n`);
    };

    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        await this.request(
            "initialize",
            {
                capabilities: { experimentalApi: true },
                clientInfo: { name: "morty", version: "1.0.0" },
            },
            AbortSignal.any([signal, AbortSignal.timeout(INITIALIZE_TIMEOUT_MILLISECONDS)]),
        );
        this.notify("initialized", undefined);
    };

    /**
     * Rejects every in-flight request and marks the conversation closed without waiting on the
     * process. Process teardown stays with the caller, which owns the process tree: it stops the
     * app-server and every tool subprocess it started.
     */
    readonly detach = (): void => {
        this.#terminate({ kind: "closed" });
    };
}
