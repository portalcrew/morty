import { CONTENT_CHUNK_MAX_BYTES, encodeContentChunkFrame, MORTY_API_PREFIX } from "@morty-build/client/protocol";
import * as v from "valibot";
import { onTestFinished } from "vitest";
import { RequestDeadline } from "../../src/http/request-deadline.ts";

type Fetch = (request: Request) => Response | Promise<Response>;

/** Request framing belongs to the WebSocket connection, not to the operation carried inside it. */
export function browserOperationHeaders(request: Request) {
    return Array.from(request.headers.entries()).filter(([name]) => name !== "content-length" && name !== "upgrade");
}

export async function closeBrowserSocket(socket: WebSocket, signal: AbortSignal): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
        return;
    }
    using deadline = new RequestDeadline(signal, 10_000);
    const pending = Promise.withResolvers<void>();
    const closed = () => pending.resolve();
    const aborted = () => pending.reject(deadline.signal.reason);
    socket.addEventListener("close", closed, { once: true });
    deadline.signal.addEventListener("abort", aborted, { once: true });
    try {
        deadline.signal.throwIfAborted();
        socket.close(1000, "Browser complete");
        await pending.promise;
    } finally {
        socket.removeEventListener("close", closed);
        deadline.signal.removeEventListener("abort", aborted);
    }
}
const reply = v.variant("kind", [
    v.object({
        kind: v.literal("http.response"),
        requestId: v.string(),
        status: v.number(),
        headers: v.array(v.tuple([v.string(), v.string()])),
        body: v.string(),
    }),
    v.object({
        kind: v.literal("http.error"),
        requestId: v.string(),
        status: v.number(),
        code: v.string(),
        message: v.string(),
    }),
]);

/** A protocol client, not an HTTP alternative: every operation crosses the actual browser WS boundary. */
export async function requestBrowserOperation(
    fetch: Fetch,
    request: Request,
    transportBody?: string,
): Promise<Response> {
    using deadline = new RequestDeadline(request.signal, 30_000);
    const target = new URL(request.url);
    const computerId = target.pathname.slice(`${MORTY_API_PREFIX}/v1/computers/`.length).split("/")[0];
    const endpoint = new URL(`${MORTY_API_PREFIX}/v1/computers/${computerId}/transport`, target);
    const opened = await fetch(new Request(endpoint, { headers: { upgrade: "websocket" }, signal: deadline.signal }));
    if (opened.status !== 101 || opened.webSocket === null) {
        return opened;
    }
    const socket = opened.webSocket;
    const requestId = crypto.randomUUID();
    const pending = Promise.withResolvers<Response>();
    const receive = (event: MessageEvent) => {
        try {
            const frame = v.parse(reply, JSON.parse(String(event.data)));
            if (frame.requestId !== requestId) {
                return;
            }
            pending.resolve(
                frame.kind === "http.response"
                    ? new Response([204, 205, 304].includes(frame.status) ? null : frame.body, {
                          status: frame.status,
                          headers: frame.headers,
                      })
                    : Response.json({ error: { code: frame.code, message: frame.message } }, { status: frame.status }),
            );
        } catch (cause) {
            pending.reject(cause);
        }
    };
    const abort = () => pending.reject(deadline.signal.reason);
    const closed = () => pending.reject(new Error("The browser operation transport closed before answering"));
    socket.addEventListener("message", receive);
    socket.addEventListener("close", closed);
    deadline.signal.addEventListener("abort", abort, { once: true });
    onTestFinished(() => socket.close(1000, "Test complete"));
    socket.accept();
    try {
        deadline.signal.throwIfAborted();
        const bytes = request.headers.has("x-morty-byte-length") ? new Uint8Array(await request.arrayBuffer()) : null;
        socket.send(
            JSON.stringify({
                kind: "http.request",
                requestId,
                method: request.method,
                path: `${target.pathname}${target.search}`,
                headers: browserOperationHeaders(request),
                body: bytes === null ? (transportBody ?? (await request.text())) : "",
                ...(bytes === null ? {} : { bodyByteLength: bytes.byteLength }),
            }),
        );
        if (bytes !== null) {
            for (
                let offset = 0, sequence = 0;
                offset < bytes.byteLength;
                offset += CONTENT_CHUNK_MAX_BYTES, sequence += 1
            ) {
                socket.send(
                    encodeContentChunkFrame({
                        requestId,
                        sequence,
                        bytes: bytes.subarray(offset, offset + CONTENT_CHUNK_MAX_BYTES),
                    }).slice().buffer,
                );
            }
        }
        return await pending.promise;
    } finally {
        deadline.signal.removeEventListener("abort", abort);
        socket.removeEventListener("message", receive);
        socket.removeEventListener("close", closed);
        if (deadline.signal.aborted) {
            socket.close(1000, "Operation cancelled");
        } else {
            await closeBrowserSocket(socket, deadline.signal);
        }
    }
}
