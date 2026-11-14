import { diagnosticText } from "../../../infra/log-diagnostics.ts";
import { logger } from "../../../infra/logger.ts";
import { CloudflareRelaySocket } from "./gateway/cloudflare-relay-peers.ts";
import type { RuntimeContext as DurableObjectContext } from "./runtime-context.ts";

function socketLogContext(webSocket: WebSocket) {
    try {
        const identity = new CloudflareRelaySocket(webSocket).identity();
        const { computerId, role } = identity;
        return {
            computerId,
            role,
            ...("connectionEpoch" in identity ? { connectionEpoch: identity.connectionEpoch } : {}),
        };
    } catch {
        // A socket can fail before it has a valid attachment.
        return { role: "unknown" };
    }
}

/** DO-owned daemon/relay peer messages and lifecycle, with no HTTP fetch entrypoint. */
export class DaemonWebSocketRoutes {
    readonly #dependencies: DurableObjectContext;
    readonly #logger: typeof logger;

    constructor(dependencies: DurableObjectContext, diagnostics = logger) {
        this.#dependencies = dependencies;
        this.#logger = diagnostics;
    }

    async webSocketMessage(webSocket: WebSocket, message: unknown): Promise<void> {
        const socket = new CloudflareRelaySocket(webSocket);
        const controller = new AbortController();
        const close = () => controller.abort(new DOMException("The channel socket closed", "AbortError"));
        webSocket.addEventListener("close", close, { once: true });
        try {
            await this.#dependencies.services.runtime.receiveMessage(
                socket.identity(),
                socket,
                message,
                controller.signal,
            );
        } catch (error) {
            if (!controller.signal.aborted || error !== controller.signal.reason) {
                this.#logger.error(
                    { ...socketLogContext(webSocket), err: error, event: "computer_websocket_message_failed" },
                    "Computer WebSocket message failed",
                );
            }
            throw error;
        } finally {
            webSocket.removeEventListener("close", close);
        }
    }

    async webSocketClose(
        webSocket: WebSocket,
        close: { readonly code: number; readonly reason: string; readonly wasClean: boolean },
    ): Promise<void> {
        // Complete the peer's close handshake, including viewers consumed inside this same DO.
        webSocket.close(1000, "Computer connection closed");
        const context = socketLogContext(webSocket);
        const details = {
            ...context,
            closeCode: close.code,
            closeReason: diagnosticText(close.reason),
            wasClean: close.wasClean,
            event: "computer_websocket_closed",
        };
        if (!close.wasClean || (close.code !== 1000 && close.code !== 1001)) {
            this.#logger.warn(details, "Computer WebSocket closed");
        } else if (context.role === "daemon") {
            this.#logger.info(details, "Computer WebSocket closed");
        }
        const socket = new CloudflareRelaySocket(webSocket);
        try {
            await this.withOperationSignal((signal) =>
                this.#dependencies.services.runtime.detach(socket.identity(), socket, signal),
            );
        } catch (error) {
            this.#logger.error(
                { ...details, err: error, event: "computer_websocket_detach_failed" },
                "Computer WebSocket detach failed",
            );
            throw error;
        }
    }

    /** Closes live Session views whose credential no longer authorizes them. */
    async reauthorizeConnections(): Promise<void> {
        await this.withOperationSignal((signal) => this.#dependencies.services.runtime.reauthorizeConnections(signal));
    }

    webSocketError(socket: WebSocket, error: unknown): void {
        this.#logger.error(
            { ...socketLogContext(socket), err: error, event: "computer_websocket_error" },
            "Computer WebSocket error",
        );
        socket.close(1011, "WebSocket error");
    }

    private readonly withOperationSignal = async <T>(
        operation: (signal: AbortSignal) => Promise<T>,
        parentSignal?: AbortSignal,
    ): Promise<T> => {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException("Computer operation timed out", "TimeoutError")),
            30_000,
        );
        try {
            return await operation(
                parentSignal === undefined ? controller.signal : AbortSignal.any([parentSignal, controller.signal]),
            );
        } finally {
            clearTimeout(timer);
        }
    };
}
