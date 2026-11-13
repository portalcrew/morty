import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/** Transparent network hop: every request still reaches the real Worker, and every Agent operation the real daemon. */
export async function recordingRelay(upstreamOrigin: string) {
    const frames: { readonly direction: string; readonly data: string }[] = [];
    const upstreamSockets = new Set<WebSocket>();
    const failures = Promise.withResolvers<never>();
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
                frames.push({ direction: "client-to-relay", data: body.toString() });
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
            if (response.body === null) {
                outgoing.end();
            } else {
                const reader = response.body.getReader();
                const close = () => {
                    void reader.cancel().catch(failures.reject);
                };
                outgoing.once("close", close);
                try {
                    while (true) {
                        const chunk = await reader.read();
                        if (chunk.done) {
                            break;
                        }
                        frames.push({ direction: "relay-to-client", data: Buffer.from(chunk.value).toString() });
                        if (!outgoing.write(chunk.value)) {
                            await once(outgoing, "drain", { signal: deadline });
                        }
                    }
                    outgoing.end();
                } finally {
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
                    frames.push({ direction: `${peer}-to-relay`, data: data.toString() });
                    if (upstream.readyState === WebSocket.OPEN) {
                        upstream.send(data, { binary });
                    }
                });
                upstream.on("message", (data, binary) => {
                    frames.push({ direction: `relay-to-${peer}`, data: data.toString() });
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
        failure: failures.promise,
        [Symbol.asyncDispose]: async () => {
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
