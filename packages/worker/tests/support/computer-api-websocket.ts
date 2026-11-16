import { once } from "node:events";
import * as v from "valibot";
import { WebSocket } from "ws";

const responseSchema = v.object({
    kind: v.literal("http.response"),
    requestId: v.string(),
    status: v.number(),
    headers: v.array(v.tuple([v.string(), v.string()])),
    body: v.string(),
});

export async function connectComputerApiWebSocket(origin: string, computerId: string, signal: AbortSignal) {
    const endpoint = new URL(`/morty/api/v1/computers/${computerId}/transport`, origin);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(endpoint);
    try {
        await once(socket, "open", { signal });
    } catch (cause) {
        socket.terminate();
        throw cause;
    }
    return {
        close: () => socket.close(),
        fetch: async (request: Request): Promise<Response> => {
            const requestId = crypto.randomUUID();
            const url = new URL(request.url);
            const body = await request.text();
            const operationSignal = AbortSignal.any([signal, request.signal]);
            operationSignal.throwIfAborted();
            return await new Promise<Response>((resolve, reject) => {
                const cleanup = () => {
                    socket.off("message", message);
                    socket.off("close", closed);
                    operationSignal.removeEventListener("abort", abort);
                };
                const closed = () => {
                    cleanup();
                    reject(new Error("Computer WebSocket closed"));
                };
                const abort = () => {
                    cleanup();
                    socket.send(JSON.stringify({ kind: "http.cancel", requestId }));
                    reject(operationSignal.reason);
                };
                const message = (data: unknown) => {
                    try {
                        const decoded: unknown = JSON.parse(String(data));
                        const identity = v.parse(v.object({ requestId: v.string() }), decoded);
                        if (identity.requestId !== requestId) {
                            return;
                        }
                        const envelope = v.parse(v.object({ kind: v.string() }), decoded);
                        if (envelope.kind === "http.error") {
                            const error = v.parse(
                                v.object({ code: v.string(), message: v.string(), status: v.number() }),
                                decoded,
                            );
                            cleanup();
                            resolve(
                                Response.json(
                                    { error: { code: error.code, message: error.message } },
                                    { status: error.status },
                                ),
                            );
                            return;
                        }
                        const result = v.parse(responseSchema, decoded);
                        cleanup();
                        resolve(
                            new Response(result.status === 204 ? null : result.body, {
                                status: result.status,
                                headers: result.headers,
                            }),
                        );
                    } catch (cause) {
                        cleanup();
                        reject(cause);
                    }
                };
                socket.on("message", message);
                socket.once("close", closed);
                operationSignal.addEventListener("abort", abort, { once: true });
                socket.send(
                    JSON.stringify({
                        kind: "http.request",
                        requestId,
                        method: request.method,
                        path: `${url.pathname}${url.search}`,
                        headers: Array.from(request.headers.entries()),
                        body,
                    }),
                );
            });
        },
    };
}
