import { E2EError, type PayloadEncryptionConnection } from "@morty-build/client";
import {
    COMPUTER_HEARTBEAT_ACK_KIND,
    COMPUTER_HEARTBEAT_MESSAGE,
    COMPUTER_LIVENESS_READY_KIND,
    decodeMessageKind,
    decodeWorkerToDaemonMessage,
} from "@morty-build/client/protocol";
import { type MessageEvent, WebSocket } from "undici";
import type { Timer } from "../../util/timer.ts";
import type { CommandServices } from "../command/context.ts";
import { createCommandRegistry } from "../command/registry/index.ts";
import { createSessionSubscriptions } from "../command/registry/subscriptions.ts";
import { receive, send } from "../command/transport.ts";
import type { RuntimeConfig } from "../config.ts";
import { ComputerRelayRevokedError, isComputerRelayRevocation } from "./computer-revocation.ts";
import { connectRelay } from "./connect.ts";
import type { RelayConnectionDiagnostics } from "./diagnostics.ts";
import { RelayConnectionLiveness } from "./liveness.ts";
import { relayCredentialHeaders } from "./relay-authentication.ts";
import type { RuntimeSessionEventPublisher } from "./session-event-publisher.ts";

/** A bounded local write of the credential the Relay accepted. */
const CREDENTIAL_SAVE_TIMEOUT_MILLISECONDS = 10_000;
const MAX_QUEUED_INCOMING_BYTES = 32 * 1024 * 1024;
const MAX_QUEUED_INCOMING_MESSAGES = 1024;

function closeRelaySocket(socket: WebSocket, code: number, reason: string): void {
    try {
        socket.close(code, reason);
    } catch (error) {
        console.error("Morty daemon could not close the Relay WebSocket", error);
        try {
            socket.close();
        } catch (fallbackError) {
            console.error("Morty daemon could not release the Relay WebSocket", fallbackError);
        }
    }
}

export interface RelayConnectionOptions {
    readonly services: CommandServices;
    readonly config: RuntimeConfig;
    readonly publisher: RuntimeSessionEventPublisher;
    readonly payloadEncryption: PayloadEncryptionConnection;
    readonly connectionEpoch: number;
    readonly diagnostics: RelayConnectionDiagnostics;
    readonly onConnected: () => void;
    readonly signal: AbortSignal;
    readonly timer: Timer;
}

export async function runRelayConnection({
    services,
    config,
    publisher,
    payloadEncryption,
    connectionEpoch,
    diagnostics,
    onConnected,
    signal,
    timer,
}: RelayConnectionOptions): Promise<void> {
    const relayUrl = new URL(config.relayUrl);
    const rotation = await config.credentials.prepare(signal);
    const relay = await connectRelay(relayUrl, relayCredentialHeaders(rotation), signal, (failure, source) => {
        diagnostics.transportFailed(connectionEpoch, failure, source);
    });
    const { socket } = relay;
    // Saving the rotation waits for the Relay to confirm the connection: a Relay can also open a socket only to close it,
    // as it does for a revoked Computer. Until then the next connection repeats the same rotation, which is harmless.
    let rotationSaved: Promise<void> = Promise.resolve();
    diagnostics.connectionOpened(connectionEpoch);
    const connectionController = new AbortController();
    const subscriptions = createSessionSubscriptions(publisher.subscriptionsChanged);
    const pendingCommands = new Set<Promise<void>>();
    let incoming: Promise<void> = Promise.resolve();
    let queuedMessages = 0;
    let queuedBytes = 0;
    const commands = createCommandRegistry({
        ...services,
        config,
        diagnostics,
        socket,
        payloadEncryption,
        subscriptions,
        signal: connectionController.signal,
        timer,
    });

    try {
        await new Promise<void>((resolve, reject) => {
            let finished = false;
            let ready = false;

            const cleanup = (): void => {
                connectionLiveness.close();
                signal.removeEventListener("abort", stop);
                socket.removeEventListener("close", handleClose);
                socket.removeEventListener("error", handleError);
                socket.removeEventListener("message", handleMessage);
                publisher.disconnect(socket);
                connectionController.abort();
                subscriptions.close();
            };

            const resolveConnection = (): void => {
                if (finished) {
                    return;
                }
                finished = true;
                cleanup();
                resolve();
            };

            const rejectConnection = (failure: Error): void => {
                if (finished) {
                    return;
                }
                finished = true;
                cleanup();
                reject(failure);
            };

            const stop = (): void => {
                // A planned upgrade can follow the last completion before the batch timer fires.
                const finish = (): void => {
                    diagnostics.connectionClosed(connectionEpoch, 1000, "Daemon stopped", "daemon_stop");
                    closeRelaySocket(socket, 1000, "Daemon stopped");
                    resolveConnection();
                };
                void publisher.flush().then(finish, finish);
            };

            const failAndClose = (failure: Error, code: number, reason: string, source: string): void => {
                diagnostics.connectionFailed(connectionEpoch, failure, source);
                diagnostics.connectionClosed(connectionEpoch, code, reason, source);
                closeRelaySocket(socket, code, reason);
                rejectConnection(failure);
            };

            const connectionLiveness = new RelayConnectionLiveness(timer, {
                send: () => {
                    if (socket.readyState !== WebSocket.OPEN) {
                        return false;
                    }
                    try {
                        send(socket, COMPUTER_HEARTBEAT_MESSAGE);
                        return true;
                    } catch (error) {
                        if (socket.readyState !== WebSocket.OPEN) {
                            return false;
                        }
                        throw error;
                    }
                },
                unresponsive: (timeoutMilliseconds) => {
                    diagnostics.heartbeatTimedOut(connectionEpoch, timeoutMilliseconds);
                    diagnostics.connectionClosed(
                        connectionEpoch,
                        4001,
                        "Relay liveness check timed out",
                        "heartbeat_timeout",
                    );
                    closeRelaySocket(socket, 4001, "Relay liveness check timed out");
                    resolveConnection();
                },
            });

            signal.addEventListener("abort", stop, { once: true });
            const handleClose = (event: CloseEvent): void => {
                diagnostics.connectionClosed(connectionEpoch, event.code, event.reason, "relay");
                if (isComputerRelayRevocation(event.code, event.reason)) {
                    rejectConnection(new ComputerRelayRevokedError(event.code, event.reason));
                    return;
                }
                resolveConnection();
            };
            const handleError = (event: Event): void => {
                if (signal.aborted) {
                    resolveConnection();
                    return;
                }
                const cause = Reflect.get(event, "error");
                const failure = new Error("Relay WebSocket emitted an error", { cause: cause ?? event });
                diagnostics.connectionFailed(connectionEpoch, failure, "socket_error");
                diagnostics.connectionClosed(connectionEpoch, 1006, "WebSocket error", "socket_error");
                rejectConnection(failure);
            };
            const handleMessage = (event: MessageEvent<unknown>): void => {
                const encoded: unknown = event.data;
                if (typeof encoded !== "string") {
                    const size =
                        encoded instanceof ArrayBuffer
                            ? encoded.byteLength
                            : ArrayBuffer.isView(encoded)
                              ? encoded.byteLength
                              : 0;
                    if (
                        size === 0 ||
                        queuedMessages >= MAX_QUEUED_INCOMING_MESSAGES ||
                        queuedBytes + size > MAX_QUEUED_INCOMING_BYTES
                    ) {
                        failAndClose(
                            new Error("Encrypted receive queue full or invalid frame"),
                            4008,
                            "Invalid content chunk",
                            "protocol",
                        );
                        return;
                    }
                    queuedMessages += 1;
                    queuedBytes += size;
                    incoming = incoming
                        .then(
                            async () =>
                                await commands.dispatchChunk(
                                    encoded,
                                    AbortSignal.any([connectionController.signal, AbortSignal.timeout(10_000)]),
                                ),
                        )
                        .catch((error: unknown) => {
                            if (!connectionController.signal.aborted) {
                                if (error instanceof E2EError && error.code === "e2e_store_busy") {
                                    failAndClose(error, 1011, "Encryption store busy", "encryption_capacity");
                                    return;
                                }
                                failAndClose(
                                    new Error("Relay sent an invalid content chunk", { cause: error }),
                                    4008,
                                    "Invalid content chunk",
                                    "protocol",
                                );
                            }
                        })
                        .finally(() => {
                            queuedMessages -= 1;
                            queuedBytes -= size;
                        });
                    return;
                }

                try {
                    const wireKind = decodeMessageKind(encoded);
                    if (wireKind !== COMPUTER_LIVENESS_READY_KIND && wireKind !== COMPUTER_HEARTBEAT_ACK_KIND) {
                        const size = Buffer.byteLength(encoded, "utf8");
                        if (
                            queuedMessages >= MAX_QUEUED_INCOMING_MESSAGES ||
                            queuedBytes + size > MAX_QUEUED_INCOMING_BYTES
                        ) {
                            throw new Error("Encrypted receive queue full");
                        }
                        queuedMessages += 1;
                        queuedBytes += size;
                        incoming = incoming
                            .then(async () => {
                                const message = await receive(
                                    encoded,
                                    payloadEncryption,
                                    AbortSignal.any([connectionController.signal, AbortSignal.timeout(10_000)]),
                                );
                                const result = commands.dispatch(message);
                                if (result !== undefined) {
                                    const operation = result.catch((error: unknown) => {
                                        if (!connectionController.signal.aborted) {
                                            diagnostics.daemonDiagnostic("command_failed", "unknown", {}, error);
                                        }
                                    });
                                    pendingCommands.add(operation);
                                    void operation.finally(() => pendingCommands.delete(operation));
                                }
                            })
                            .catch(async (error: unknown) => {
                                if (!connectionController.signal.aborted) {
                                    if (error instanceof E2EError && error.code === "e2e_store_busy") {
                                        try {
                                            if (await commands.reportCapacity(encoded)) {
                                                return;
                                            }
                                        } catch (cause) {
                                            if (connectionController.signal.aborted) {
                                                return;
                                            }
                                            failAndClose(
                                                new Error("Unable to report encryption capacity", { cause }),
                                                1011,
                                                "Encryption store busy",
                                                "encryption_capacity",
                                            );
                                            return;
                                        }
                                        failAndClose(error, 1011, "Encryption store busy", "encryption_capacity");
                                        return;
                                    }
                                    diagnostics.daemonDiagnostic("protocol_message_discarded", "unknown", {
                                        reason: "encrypted_message_invalid",
                                    });
                                }
                            })
                            .finally(() => {
                                queuedMessages -= 1;
                                queuedBytes -= size;
                            });
                        return;
                    }
                    const message = decodeWorkerToDaemonMessage(encoded);
                    const kind = message.kind;
                    if (kind === COMPUTER_LIVENESS_READY_KIND) {
                        if (ready) {
                            return;
                        }
                        ready = true;
                        // The Relay made the successor current as it accepted this connection. The save finishes even
                        // when the daemon stops meanwhile: it records what the Relay already holds.
                        rotationSaved = config.credentials.complete(
                            rotation,
                            AbortSignal.timeout(CREDENTIAL_SAVE_TIMEOUT_MILLISECONDS),
                        );
                        rotationSaved.catch((error: unknown) => {
                            if (finished) {
                                return;
                            }
                            failAndClose(
                                new Error("The rotated Computer credential could not be saved", { cause: error }),
                                1011,
                                "Computer credential unavailable",
                                "credential",
                            );
                        });
                        publisher.connect(socket, subscriptions.isSubscribed);
                        connectionLiveness.start();
                        onConnected();
                        return;
                    }
                    if (kind === COMPUTER_HEARTBEAT_ACK_KIND) {
                        connectionLiveness.acknowledge();
                        return;
                    }
                    throw new Error("Unexpected relay control");
                } catch (error) {
                    console.error("Morty daemon rejected a message", error);
                    failAndClose(
                        new Error("Relay sent an invalid protocol message", { cause: error }),
                        4008,
                        "Invalid protocol message",
                        "protocol",
                    );
                }
            };
            socket.addEventListener("close", handleClose);
            socket.addEventListener("error", handleError);
            socket.addEventListener("message", handleMessage);

            if (signal.aborted) {
                stop();
            }
        });
    } finally {
        connectionController.abort();
        await incoming;
        await Promise.allSettled([...pendingCommands]);
        await commands.settle();
        // The next connection presents what this one saved.
        await rotationSaved.catch(() => undefined);
        relay.release(new Error("Relay connection released"));
    }
}
