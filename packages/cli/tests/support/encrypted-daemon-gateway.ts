import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    decodeMessageKind,
    decodeSessionReadyEvent,
    type NativeSessionTarget,
} from "@morty-build/client/protocol";
import type { WebSocket } from "ws";
import { encryptedContentFrames } from "./agents/encrypted-content-frames.ts";
import { createEncryptedDaemonFrames } from "./encrypted-daemon-frames.ts";

export interface EncryptedDaemonPeer {
    readonly send: (message: string | Uint8Array) => Promise<void>;
    readonly next: (signal?: AbortSignal) => Promise<string>;
    readonly nextFrame: (signal?: AbortSignal) => Promise<string | Buffer>;
    readonly observe: (listener: (message: string) => void) => void;
}

/** Owns the Computer capability and each relay-side connection using it. */
export async function createEncryptedDaemonGateway(stateDirectory: string, computerId: string, signal: AbortSignal) {
    const frames = await createEncryptedDaemonFrames(stateDirectory, computerId, signal);
    const contentFrames = encryptedContentFrames(frames.encryption, signal);
    const connections = new Map<WebSocket, () => Promise<unknown>>();
    const subscriptions = new Map<string, NativeSessionTarget>();
    const connect = (socket: WebSocket): EncryptedDaemonPeer => {
        const messages: Array<string | Buffer> = [];
        const readers: Array<PromiseWithResolvers<string | Buffer>> = [];
        let failure: unknown;
        let receiveTail = Promise.resolve();
        let sendTail = Promise.resolve();
        const listeners: Array<(message: string) => void> = [];
        const send = (message: string | Uint8Array): Promise<void> => {
            sendTail = sendTail.then(async () => {
                signal.throwIfAborted();
                socket.send(
                    typeof message === "string" ? await frames.encode(message) : await contentFrames.encode(message),
                );
            });
            return sendTail;
        };
        const subscribe = (target: NativeSessionTarget): Promise<void> => {
            subscriptions.set(JSON.stringify(target), target);
            return send(
                JSON.stringify({ kind: "session.events.subscribe", subscriptionId: crypto.randomUUID(), target }),
            );
        };
        const fail = (cause: unknown): void => {
            failure = cause;
            for (const reader of readers.splice(0)) {
                reader.reject(cause);
            }
        };
        const abort = (): void => fail(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        socket.once("close", () => {
            signal.removeEventListener("abort", abort);
            fail(new Error("Daemon test connection closed"));
            void Promise.allSettled([receiveTail, sendTail]).then(() => connections.delete(socket));
        });
        socket.on("message", (data, binary) => {
            const message = data.toString();
            if (message === COMPUTER_HEARTBEAT_MESSAGE) {
                socket.send(COMPUTER_HEARTBEAT_ACK_MESSAGE);
                return;
            }
            receiveTail = receiveTail.then(async () => {
                const bytes = Array.isArray(data)
                    ? Buffer.concat(data)
                    : data instanceof ArrayBuffer
                      ? Buffer.from(data)
                      : data;
                const decoded = binary ? Buffer.from(await contentFrames.decode(bytes)) : await frames.decode(message);
                if (typeof decoded === "string" && decodeMessageKind(decoded) === "session.ready") {
                    await subscribe(decodeSessionReadyEvent(decoded).target);
                }
                for (const listener of listeners) {
                    if (typeof decoded === "string") {
                        listener(decoded);
                    }
                }
                const reader = readers.shift();
                if (reader === undefined) {
                    messages.push(decoded);
                } else {
                    reader.resolve(decoded);
                }
            });
            void receiveTail.catch(fail);
        });
        connections.set(socket, () => Promise.allSettled([receiveTail, sendTail]));
        socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
        for (const target of subscriptions.values()) {
            void subscribe(target).catch(fail);
        }
        const nextFrame = async (readSignal = signal): Promise<string | Buffer> => {
            readSignal.throwIfAborted();
            const message = messages.shift();
            if (message !== undefined) {
                return message;
            }
            if (failure !== undefined) {
                throw failure;
            }
            const reader = Promise.withResolvers<string | Buffer>();
            readers.push(reader);
            const abortRead = (): void => {
                const index = readers.indexOf(reader);
                if (index !== -1) {
                    readers.splice(index, 1);
                }
                reader.reject(readSignal.reason);
            };
            readSignal.addEventListener("abort", abortRead, { once: true });
            try {
                return await reader.promise;
            } finally {
                readSignal.removeEventListener("abort", abortRead);
            }
        };
        return {
            send,
            observe: (listener) => {
                listeners.push(listener);
            },
            nextFrame,
            next: async (readSignal?: AbortSignal) => {
                const frame = await nextFrame(readSignal);
                if (typeof frame !== "string") {
                    throw new Error("Expected a text daemon message");
                }
                return frame;
            },
        };
    };
    return {
        connect,
        close: async (): Promise<void> => {
            const pending = [...connections.values()].map((drain) => drain());
            for (const socket of connections.keys()) {
                socket.terminate();
            }
            await Promise.allSettled(pending);
            await frames.close();
        },
    };
}
