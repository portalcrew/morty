import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { type MortyTransportCall, type MortyTransportEndpoint, WsTransport } from "../src/index.ts";

const operation = z.object({
    kind: z.literal("http.request"),
    requestId: z.string(),
    method: z.string(),
    path: z.string(),
    headers: z.array(z.tuple([z.string(), z.string()])),
    body: z.string(),
});
const envelope = z.discriminatedUnion("kind", [
    operation,
    z.object({ kind: z.literal("ping") }),
    z.object({ kind: z.literal("http.cancel"), requestId: z.string() }),
]);

/** Stateful Worker wire contract: Computer APIs are WebSocket-only; bootstrap remains HTTP. */
async function computerPeer() {
    let access: "active" | "revoked" = "active";
    const waiting = new Set<string>();
    const pending = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
        if (request.url === "/morty/api/v1/computers/computer-1/setup" && request.method === "POST") {
            response.writeHead(202);
            response.end();
            return;
        }
        if (
            request.url === "/morty/api/v1/computers/computer-1/harnesses/codex/sessions/session-1/files/content" &&
            request.method === "GET"
        ) {
            response.writeHead(200, {
                "content-type": "text/plain",
                "content-disposition": "attachment; filename=notes.txt",
            });
            response.end("Downloaded over HTTP");
            return;
        }
        if (request.url === "/morty/api/v1/identity/transfers/redeem" && request.method === "POST") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ computerId: "computer-1", computerToken: "owner" }));
            return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Use the Computer WebSocket" } }));
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
        sockets.handleUpgrade(request, socket, head, (connection) => {
            connection.on("message", (bytes) => {
                const decoded: unknown = JSON.parse(bytes.toString());
                const message = envelope.parse(decoded);
                if (message.kind === "ping") {
                    connection.send(JSON.stringify({ kind: "pong" }));
                    return;
                }
                if (message.kind === "http.cancel") {
                    if (waiting.delete(message.requestId)) {
                        cancelled.resolve();
                    }
                    return;
                }
                const headers = new Headers(message.headers);
                let status = 200;
                let body: unknown = { computerId: "computer-1", authentication: { kind: "anonymous" } };
                if (headers.get("authorization") !== "Bearer owner" || access === "revoked") {
                    status = 401;
                    body = { error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } };
                } else if (message.path === "/morty/api/v1/computers/computer-1/agent-settings") {
                    waiting.add(message.requestId);
                    pending.resolve();
                    return;
                } else if (
                    message.method === "DELETE" &&
                    message.path === "/morty/api/v1/computers/computer-1/identity/browser-access"
                ) {
                    access = "revoked";
                    status = 204;
                    body = null;
                }
                connection.send(
                    JSON.stringify({
                        kind: "http.response",
                        requestId: message.requestId,
                        status,
                        headers: [["content-type", "application/json"]],
                        body: body === null ? "" : JSON.stringify(body),
                    }),
                );
            });
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected a local address");
    }
    onTestFinished(async () => {
        for (const socket of sockets.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve, reject) => sockets.close((error) => (error ? reject(error) : resolve())));
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    const origin = `http://127.0.0.1:${address.port}`;
    return {
        origin,
        pending: pending.promise,
        cancelled: cancelled.promise,
        request: (
            path: string,
            init: {
                readonly method?: MortyTransportEndpoint["method"];
                readonly signal?: AbortSignal;
                readonly transport?: "http" | "websocket";
            } = {},
        ): MortyTransportCall => ({
            endpoint: {
                computerId: "computer-1",
                method: init.method ?? "GET",
                path: `/morty/api${path}`,
                transport: init.transport === "http" ? { kind: "http" } : { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 10_000,
            },
            origin: new URL(origin),
            headers: { authorization: "Bearer owner" },
            body: null,
            signal: init.signal ?? AbortSignal.timeout(10_000),
        }),
    };
}

it("Given a Computer credential, When a client reads access and ends browser access, Then it uses WebSocket and preserves the empty 204 and subsequent authentication rejection", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const peer = await computerPeer();
    const transport = new WsTransport();
    onTestFinished(transport.close);
    const session = await transport.fetch(peer.request("/v1/computers/computer-1/session"));
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ computerId: "computer-1", authentication: { kind: "anonymous" } });
    const ended = await transport.fetch(
        peer.request("/v1/computers/computer-1/identity/browser-access", { method: "DELETE" }),
    );
    expect(ended.status).toBe(204);
    expect(await ended.text()).toBe("");
    const rejected = await transport.fetch(peer.request("/v1/computers/computer-1/session"));
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    const bootstrap = await transport.fetch(
        peer.request("/v1/identity/transfers/redeem", { method: "POST", transport: "http" }),
    );
    expect(await bootstrap.json()).toEqual({ computerId: "computer-1", computerToken: "owner" });
    const setup = await transport.fetch(
        peer.request("/v1/computers/computer-1/setup", { method: "POST", transport: "http" }),
    );
    expect(setup.status).toBe(202);
    const download = await transport.fetch(
        peer.request("/v1/computers/computer-1/harnesses/codex/sessions/session-1/files/content", {
            transport: "http",
        }),
    );
    expect(download.headers.get("content-disposition")).toBe("attachment; filename=notes.txt");
    expect(await download.text()).toBe("Downloaded over HTTP");
});

it("Given an in-flight Computer API request, When its caller cancels, Then the peer receives cancellation and the connection still serves later requests", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const peer = await computerPeer();
    const transport = new WsTransport();
    onTestFinished(transport.close);
    const controller = new AbortController();
    const result = transport.fetch(
        peer.request("/v1/computers/computer-1/agent-settings", { method: "POST", signal: controller.signal }),
    );
    const reason = new DOMException("Leaving discovery", "AbortError");
    const rejected = expect(result).rejects.toBe(reason);
    await peer.pending;
    controller.abort(reason);
    await rejected;
    await peer.cancelled;
    expect((await transport.fetch(peer.request("/v1/computers/computer-1/session"))).status).toBe(200);
});
