import type { NativeSessionCommandRouting, NativeSessionTarget } from "@morty-build/client/protocol";
import { SessionRuntimeError } from "../../../../contracts/relay/session.ts";
import { RequestDeadline } from "../../../../http/request-deadline.ts";
import { logger } from "../../../../infra/logger.ts";
import type { ClientControlReply } from "./computer-control-registry.ts";
import type { ComputerOperationSocket, RelayPeers, RelaySocket } from "./computer-relay-actor.ts";
import { type ComputerReplyConnection, RequestRejectedEvent } from "./computer-reply-request.ts";

/** What the owner of a request does with what its requester sends: a message for the Computer, a cancellation, or file credit. */
export interface LocalComputerRequestHandlers {
    readonly message: (socket: ComputerOperationSocket, message: unknown) => Promise<void>;
    readonly cancel: (socket: ComputerOperationSocket) => void;
    readonly credit: (socket: ComputerOperationSocket) => void;
}

class LocalComputerRequest extends EventTarget implements ComputerReplyConnection {
    #state: number = WebSocket.OPEN;
    readonly #handlers: LocalComputerRequestHandlers;
    readonly #release: () => void;
    readonly server: ComputerOperationSocket;

    constructor(handlers: LocalComputerRequestHandlers, release: () => void) {
        super();
        this.#handlers = handlers;
        this.#release = release;
        let request:
            | { readonly kind: "not-forwarded" }
            | {
                  readonly kind: "forwarded";
                  readonly daemon: RelaySocket;
                  readonly action: NativeSessionCommandRouting["action"];
              }
            | {
                  readonly kind: "file-read" | "content-write";
                  readonly daemon: RelaySocket;
              } = { kind: "not-forwarded" };
        // The Computer is asked for at most one Agent settings discovery per request: this one.
        let discovery: { readonly requestId: string; readonly harness: string } | null = null;
        this.server = {
            recordRequestDaemon: (daemon, action) => {
                request = { kind: "forwarded", daemon, action };
            },
            recordTransferDaemon: (daemon, kind) => {
                request = { kind, daemon };
            },
            requestDaemon: () => (request.kind === "not-forwarded" ? null : request.daemon),
            requestAction: () => (request.kind === "forwarded" ? request.action : null),
            requestTransferKind: () =>
                request.kind === "file-read" || request.kind === "content-write" ? request.kind : null,
            close: (code, reason) => this.close(code, reason),
            send: (message) => {
                if (this.isOpen()) {
                    this.dispatchEvent(new MessageEvent("message", { data: message }));
                }
            },
            reject: (code, message) => {
                if (this.isOpen()) {
                    this.dispatchEvent(new RequestRejectedEvent(code, message));
                }
            },
            computerOffline: () => {
                if (this.isOpen()) {
                    this.dispatchEvent(new Event("offline"));
                }
            },
            isOpen: () => this.isOpen(),
            isSame: (socket) => socket === this.server,
            trackAgentSettingsDiscovery: (requestId, harness) => {
                if (discovery !== null) {
                    return false;
                }
                discovery = { requestId, harness };
                return true;
            },
            consumeAgentSettingsDiscovery: (requestId, harness) => {
                if (discovery?.requestId !== requestId || discovery.harness !== harness) {
                    return false;
                }
                discovery = null;
                return true;
            },
            consumeAgentSettingsDiscoveryFailure: (requestId) => {
                if (discovery?.requestId !== requestId) {
                    return false;
                }
                discovery = null;
                return true;
            },
            endAgentSettingsDiscovery: () => {
                const pending = discovery !== null;
                discovery = null;
                return pending;
            },
        };
    }
    private readonly isOpen = () => this.#state === WebSocket.OPEN;
    readonly send = (message: string | ArrayBuffer | ArrayBufferView): void => {
        this.run(() => this.#handlers.message(this.server, message));
    };
    readonly creditFile = (): void => {
        this.run(() => this.#handlers.credit(this.server));
    };
    readonly cancel = (): void => {
        if (this.isOpen()) {
            this.run(() => this.#handlers.cancel(this.server));
        }
    };
    private readonly run = (operation: () => void | Promise<void>): void => {
        if (!this.isOpen()) {
            throw new Error("The Computer request is closed");
        }
        void (async () => await operation())().catch((cause: unknown) => {
            logger.error({ err: cause, event: "computer_local_request_failed" }, "Computer local request failed");
            this.dispatchEvent(new Event("error"));
            this.close();
        });
    };
    readonly close = (code?: number, reason?: string): void => {
        if (!this.isOpen()) {
            return;
        }
        this.#state = WebSocket.CLOSED;
        // An undrained fork reply cannot be allowed to match a later route with
        // the same durable operation identity. Closing its original transport
        // fences queued frames through the daemon message authorization boundary.
        if (this.server.requestAction() === "fork" && (code !== 1000 || reason !== "Operation finished")) {
            this.server.requestDaemon()?.close(1011, "Fork reply was not drained");
        }
        this.#release();
        this.dispatchEvent(new Event("close"));
    };
}

export class LocalComputerRequests {
    readonly #routes = new Set<ReturnType<RelayPeers["operations"]>[number]>();
    readonly #forks = new Map<string, EventTarget>();
    #pendingForks = 0;
    readonly #retain: (operation: Promise<void>) => void;

    constructor(retain: (operation: Promise<void>) => void) {
        this.#retain = retain;
    }
    readonly routes = () => [...this.#routes];
    /** Stable fork identities must not collide in the reply router. Do not join
     * opaque requests: each fresh packet must reach the Computer, which alone
     * can authorize it and compare its private intent with the durable receipt. */
    readonly runRecoverableFork = async (
        requestId: string,
        signal: AbortSignal,
        operation: (signal: AbortSignal) => Promise<ClientControlReply>,
    ): Promise<ClientControlReply> => {
        using deadline = new RequestDeadline(signal, 120_000);
        if (this.#pendingForks >= 16) {
            throw new SessionRuntimeError("session_busy", "Too many native fork requests are pending");
        }
        this.#pendingForks += 1;
        let admission: "queued" | "draining" = "queued";
        try {
            let previous = this.#forks.get(requestId);
            while (previous !== undefined) {
                const available = Promise.withResolvers<void>();
                const released = (): void => available.resolve();
                previous.addEventListener("released", released, { once: true });
                try {
                    await deadline.wait(available.promise);
                } finally {
                    previous.removeEventListener("released", released);
                }
                previous = this.#forks.get(requestId);
            }
            deadline.signal.throwIfAborted();
            const ownership = new EventTarget();
            this.#forks.set(requestId, ownership);
            admission = "draining";
            const draining = (async () => {
                // Caller cancellation stops its wait, but the issued RPC still
                // owns this reply address until a terminal reply or transport fence.
                using execution = new RequestDeadline(new AbortController().signal, 120_000);
                try {
                    return await operation(execution.signal);
                } finally {
                    this.#forks.delete(requestId);
                    this.#pendingForks -= 1;
                    ownership.dispatchEvent(new Event("released"));
                }
            })();
            this.#retain(
                draining.then(
                    () => undefined,
                    () => undefined,
                ),
            );
            return await deadline.wait(draining);
        } finally {
            if (admission === "queued") {
                this.#pendingForks -= 1;
            }
        }
    };
    readonly open = (
        requestId: string,
        target: NativeSessionTarget | undefined,
        handlers: LocalComputerRequestHandlers,
    ) => {
        for (const route of this.#routes) {
            if (route.requestId === requestId) {
                throw new SessionRuntimeError(
                    "session_busy",
                    "An operation with this request ID is already in progress",
                );
            }
        }
        const connection = new LocalComputerRequest(handlers, () => this.#routes.delete(route));
        const route = { socket: connection.server, requestId, target };
        this.#routes.add(route);
        return connection;
    };
}
