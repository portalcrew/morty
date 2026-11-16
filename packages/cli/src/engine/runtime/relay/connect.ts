import { type Dispatcher, WebSocket } from "undici";

import { environmentProxyDispatcher } from "../../util/network/environment-proxy.ts";
import { ComputerRelayRevokedError, isComputerRelayRevocation } from "./computer-revocation.ts";

// The Relay accepts a daemon only after it has made the Channel's previous connection offline, and a
// Computer that had several Sessions in flight takes longer to reach that point than a small one.
// A tight deadline made the daemon give up mid-accept, reconnect, and give up again, so allow enough room
// for a large Computer while still failing a genuinely dead Relay.
const CONNECTION_TIMEOUT_MILLISECONDS = 60_000;

export interface RelayConnection {
    readonly socket: WebSocket;
    readonly release: (reason: Error) => void;
}

class RelayConnectionError extends Error {
    readonly code: string;
    readonly diagnosticDetails: Readonly<Record<string, string>>;

    constructor(
        code: string,
        message: string,
        diagnosticDetails: Readonly<Record<string, string>> = {},
        options: ErrorOptions = {},
    ) {
        super(message, options);
        this.code = code;
        this.diagnosticDetails = diagnosticDetails;
        this.name = "RelayConnectionError";
    }
}

export function connectRelay(
    url: URL,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
    transportFailed: (failure: Error, source: string) => void = () => undefined,
): Promise<RelayConnection> {
    signal.throwIfAborted();

    return new Promise((resolve, reject) => {
        let releaseTransport: (reason: Error) => void = () => undefined;
        let removeTransportObserver = (): void => undefined;
        let released = false;
        const observeFailure = (failure: Error, source: string): void => {
            if (!released && !signal.aborted) {
                transportFailed(failure, source);
            }
        };
        const observeHandshake = (statusCode: number, expectedStatus: number): void => {
            if (statusCode !== expectedStatus) {
                observeFailure(
                    Object.assign(new Error("Relay rejected the WebSocket handshake"), {
                        code: "relay_handshake_rejected",
                        statusCode,
                    }),
                    "handshake",
                );
            }
        };
        const dispatcher = environmentProxyDispatcher.compose((dispatch) => (options, handler) => {
            const trackedHandler: Dispatcher.DispatchHandler = {
                onRequestStart: (controller, context): void => {
                    releaseTransport = (reason) => controller.abort(reason);
                    handler.onRequestStart?.(controller, context);
                },
                onRequestUpgrade: (controller, statusCode, responseHeaders, transport): void => {
                    observeHandshake(statusCode, Reflect.get(transport, "session") == null ? 101 : 200);
                    // An upgraded connection no longer belongs to the HTTP request controller.
                    // Its owner must release the socket even when the peer never acknowledges close.
                    releaseTransport = (reason) => transport.destroy(reason);
                    // The public WebSocket error event discards the original TCP/TLS error.
                    // Observe this connection's upgraded stream, never a process-global channel.
                    const onTransportError = (failure: Error): void => observeFailure(failure, "socket");
                    removeTransportObserver = (): void => {
                        transport.off("error", onTransportError);
                        transport.off("close", removeTransportObserver);
                    };
                    transport.on("error", onTransportError);
                    transport.once("close", removeTransportObserver);
                    handler.onRequestUpgrade?.(controller, statusCode, responseHeaders, transport);
                },
                onResponseStart: (controller, statusCode, responseHeaders, statusMessage): void => {
                    observeHandshake(statusCode, 101);
                    handler.onResponseStart?.(controller, statusCode, responseHeaders, statusMessage);
                },
                onResponseData: (controller, chunk): void => {
                    handler.onResponseData?.(controller, chunk);
                },
                onResponseEnd: (controller, trailers): void => {
                    handler.onResponseEnd?.(controller, trailers);
                },
                onResponseError: (controller, failure): void => {
                    observeFailure(failure, "request");
                    handler.onResponseError?.(controller, failure);
                },
            };
            return dispatch(options, trackedHandler);
        });
        const socket = new WebSocket(new URL(url), {
            dispatcher,
            headers,
        });
        socket.binaryType = "arraybuffer";
        const release = (reason: Error): void => {
            if (released) {
                return;
            }
            released = true;
            removeTransportObserver();
            releaseTransport(reason);
        };
        let finished = false;
        const timeout = setTimeout(onTimeout, CONNECTION_TIMEOUT_MILLISECONDS);

        const cleanup = (): void => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            socket.removeEventListener("close", onClose);
            socket.removeEventListener("error", onError);
            socket.removeEventListener("open", onOpen);
        };
        const fail = (error: Error): void => {
            if (finished) {
                return;
            }
            finished = true;
            cleanup();
            socket.close();
            release(error);
            reject(error);
        };
        const onAbort = (): void => {
            fail(
                new RelayConnectionError(
                    "relay_connection_cancelled",
                    "Relay connection was cancelled",
                    {
                        cancellation: "requested",
                    },
                    { cause: signal.reason },
                ),
            );
        };
        const onClose = (event: CloseEvent): void => {
            if (isComputerRelayRevocation(event.code, event.reason)) {
                fail(new ComputerRelayRevokedError(event.code, event.reason));
                return;
            }
            fail(
                new RelayConnectionError("relay_connection_closed", "Relay connection closed before it was ready", {
                    closeCode: event.code.toString(),
                    closeReason: event.reason,
                }),
            );
        };
        const onError = (event: Event): void => {
            const cause = Reflect.get(event, "error");
            fail(
                new RelayConnectionError(
                    "relay_connection_failed",
                    "Relay connection failed",
                    {},
                    { cause: cause ?? event },
                ),
            );
        };
        const onOpen = (): void => {
            if (finished) {
                return;
            }
            finished = true;
            cleanup();
            resolve({ release, socket });
        };
        function onTimeout(): void {
            fail(
                new RelayConnectionError("relay_connection_timeout", "Relay connection timed out", {
                    timeoutMilliseconds: CONNECTION_TIMEOUT_MILLISECONDS.toString(),
                }),
            );
        }

        signal.addEventListener("abort", onAbort, { once: true });
        socket.addEventListener("close", onClose, { once: true });
        socket.addEventListener("error", onError, { once: true });
        socket.addEventListener("open", onOpen, { once: true });

        if (signal.aborted) {
            onAbort();
        }
    });
}
