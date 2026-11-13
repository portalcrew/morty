import { once } from "node:events";
import { createServer } from "node:http";
import {
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    contentChunkCodec,
    decodeContentChunkAck,
    decodeMessageKind,
} from "@morty-build/client/protocol";
import { WebSocket, WebSocketServer } from "ws";

type UploadGate = {
    readonly entered: (requestId: string) => void;
    readonly held: (() => void)[];
    readonly chunks: { readonly requestId: string; readonly sequence: number }[];
};

/** Transparent network hop: every request still reaches the real Worker, and every Agent operation the real daemon. */
export async function recordingRelay(upstreamOrigin: string) {
    const frames: { readonly direction: string; readonly data: string }[] = [];
    const lifetime = new AbortController();
    const listeners = new Set<(frame: { readonly direction: string; readonly data: string }) => void>();
    const record = (frame: { readonly direction: string; readonly data: string }): void => {
        frames.push(frame);
        for (const listener of listeners) {
            listener(frame);
        }
    };
    const upstreamSockets = new Set<WebSocket>();
    let successorCredential: string | null = null;
    const failures = Promise.withResolvers<never>();
    let downloadGate: {
        readonly entered: () => void;
        readonly released: Promise<void>;
        readonly release: () => void;
    } | null = null;
    let uploadGate: UploadGate | null = null;
    const activeGates = new Set<() => void>();
    void failures.promise.catch(() => undefined);
    const sockets = new WebSocketServer({ noServer: true });
    const server = createServer((incoming, outgoing) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
                if (value !== undefined && name !== "host" && name !== "connection") {
                    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
                }
            }
            const body = Buffer.concat(chunks);
            if (body.byteLength > 0) {
                record({ direction: "client-to-relay", data: body.toString() });
            }
            const deadline = AbortSignal.timeout(30_000);
            const response = await fetch(new URL(incoming.url ?? "/", upstreamOrigin), {
                method: incoming.method ?? "GET",
                headers,
                ...(body.byteLength === 0 ? {} : { body }),
                signal: deadline,
            });
            const responseHeaders = new Headers(response.headers);
            // fetch already decoded the body; forwarding its old encoding/length would decode it a second time.
            responseHeaders.delete("content-encoding");
            responseHeaders.delete("content-length");
            outgoing.writeHead(response.status, Object.fromEntries(responseHeaders));
            const gate = incoming.url?.includes("/files/content?") ? downloadGate : null;
            if (gate !== null) {
                downloadGate = null;
                activeGates.add(gate.release);
            }
            if (response.body === null) {
                outgoing.end();
            } else {
                const reader = response.body.getReader();
                const close = () => {
                    gate?.release();
                    void reader.cancel().catch(failures.reject);
                };
                outgoing.once("close", close);
                try {
                    let paused = false;
                    while (true) {
                        const chunk = await reader.read();
                        if (chunk.done) {
                            break;
                        }
                        record({ direction: "relay-to-client", data: Buffer.from(chunk.value).toString() });
                        if (!outgoing.write(chunk.value)) {
                            await once(outgoing, "drain", { signal: deadline });
                        }
                        if (gate !== null && !paused) {
                            paused = true;
                            gate.entered();
                            await gate.released;
                            if (outgoing.destroyed) {
                                break;
                            }
                        }
                    }
                    if (!outgoing.destroyed) {
                        outgoing.end();
                    }
                } finally {
                    if (gate !== null) {
                        activeGates.delete(gate.release);
                    }
                    outgoing.off("close", close);
                    await reader.cancel();
                    reader.releaseLock();
                }
            }
        })().catch((cause: unknown) => {
            failures.reject(cause);
            outgoing.destroy(cause instanceof Error ? cause : undefined);
        });
    });
    server.on("upgrade", (request, socket, head) => {
        const target = new URL(request.url ?? "/", upstreamOrigin);
        if (target.pathname.endsWith("/connect")) {
            const successor = request.headers[COMPUTER_SUCCESSOR_CREDENTIAL_HEADER];
            if (typeof successor === "string") {
                successorCredential = successor;
            }
        }
        target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
        const headers = Object.fromEntries(
            Object.entries(request.headers).flatMap(([name, value]) =>
                value !== undefined &&
                name !== "host" &&
                name !== "connection" &&
                name !== "upgrade" &&
                !name.startsWith("sec-websocket-")
                    ? [[name, Array.isArray(value) ? value.join(", ") : value]]
                    : [],
            ),
        );
        const upstream = new WebSocket(target, { headers, handshakeTimeout: 15_000 });
        upstreamSockets.add(upstream);
        upstream.once("error", (error) => {
            failures.reject(error);
            socket.destroy(error);
        });
        upstream.once("open", () => {
            sockets.handleUpgrade(request, socket, head, (downstream) => {
                const peer = target.pathname.endsWith("/connect") ? "daemon" : "client";
                downstream.on("message", (data, binary) => {
                    record({ direction: `${peer}-to-relay`, data: data.toString() });
                    if (
                        peer === "daemon" &&
                        !binary &&
                        uploadGate !== null &&
                        decodeMessageKind(data.toString()) === "content.chunk.ack"
                    ) {
                        const gate = uploadGate;
                        const ack = decodeContentChunkAck(data.toString());
                        gate.held.push(() => {
                            if (upstream.readyState === WebSocket.OPEN) {
                                upstream.send(data, { binary });
                            }
                        });
                        gate.entered(ack.requestId);
                        return;
                    }
                    if (upstream.readyState === WebSocket.OPEN) {
                        upstream.send(data, { binary });
                    }
                });
                upstream.on("message", (data, binary) => {
                    record({ direction: `relay-to-${peer}`, data: data.toString() });
                    if (peer === "daemon" && binary && uploadGate !== null) {
                        const chunk = contentChunkCodec.decodeRouting(data);
                        uploadGate.chunks.push({ requestId: chunk.requestId, sequence: chunk.sequence });
                    }
                    if (downstream.readyState === WebSocket.OPEN) {
                        downstream.send(data, { binary });
                    }
                });
                downstream.once("close", () => upstream.close(1000, "Peer disconnected"));
                upstream.once("close", () => {
                    upstreamSockets.delete(upstream);
                    downstream.close(1000, "Peer disconnected");
                });
                downstream.once("error", failures.reject);
            });
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected a loopback listener");
    }
    return {
        origin: `http://127.0.0.1:${address.port}`,
        frames,
        successorCredential: () => {
            if (successorCredential === null) {
                throw new Error("The daemon has not supplied a successor credential");
            }
            return successorCredential;
        },
        pauseUploadAcknowledgements: () => {
            if (uploadGate !== null) {
                throw new Error("An upload gate is already armed");
            }
            const entered = Promise.withResolvers<string>();
            const gate: UploadGate = {
                entered: entered.resolve,
                held: [],
                chunks: [],
            };
            uploadGate = gate;
            return {
                entered: entered.promise,
                chunks: gate.chunks,
                release: () => {
                    if (uploadGate === gate) {
                        uploadGate = null;
                    }
                    for (const forward of gate.held.splice(0)) {
                        forward();
                    }
                },
            };
        },
        pauseNextDownload: () => {
            if (downloadGate !== null) {
                throw new Error("A download gate is already armed");
            }
            const entered = Promise.withResolvers<void>();
            const released = Promise.withResolvers<void>();
            downloadGate = { entered: entered.resolve, released: released.promise, release: released.resolve };
            return { entered: entered.promise, release: released.resolve };
        },
        waitForFrame: async (
            from: number,
            matches: (frame: { readonly direction: string; readonly data: string }) => boolean,
            signal: AbortSignal,
        ) => {
            const deadline = AbortSignal.any([signal, lifetime.signal]);
            deadline.throwIfAborted();
            const existing = frames.slice(from).find(matches);
            if (existing !== undefined) {
                return existing;
            }
            return await new Promise<{ readonly direction: string; readonly data: string }>((resolve, reject) => {
                const cleanup = () => {
                    listeners.delete(receive);
                    deadline.removeEventListener("abort", abort);
                };
                const receive = (frame: { readonly direction: string; readonly data: string }) => {
                    if (matches(frame)) {
                        cleanup();
                        resolve(frame);
                    }
                };
                const abort = () => {
                    cleanup();
                    reject(deadline.reason);
                };
                listeners.add(receive);
                deadline.addEventListener("abort", abort, { once: true });
                if (deadline.aborted) {
                    abort();
                }
            });
        },
        failure: failures.promise,
        [Symbol.asyncDispose]: async () => {
            lifetime.abort(new DOMException("Recording relay closed", "AbortError"));
            downloadGate?.release();
            for (const release of activeGates) {
                release();
            }
            for (const socket of upstreamSockets) {
                socket.terminate();
            }
            for (const socket of sockets.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve, reject) => sockets.close((error) => (error ? reject(error) : resolve())));
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
