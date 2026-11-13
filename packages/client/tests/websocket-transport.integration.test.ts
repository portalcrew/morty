// @vitest-environment happy-dom

import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
    MortyClient,
    MortyConnectionError,
    type MortyTransportCall,
    type MortyWebSocketConnector,
    WsTransport,
} from "../src/index.ts";

// Only the Relay verifies the credential; routing uses the explicit endpoint target.
const sessionClaims = btoa(
    JSON.stringify({
        issuedAtEpochMilliseconds: 0,
        expiresAtEpochMilliseconds: 900000,
        purpose: "session-access",
        computerId: "computer-1",
        grant: { holder: { kind: "credential", credentialId: "owner-1" }, generation: 1 },
        target: { harness: "claude", sessionId: "session-1" },
    }),
)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
const sessionCredential = `msession_${sessionClaims}.${"A".repeat(43)}`;

function computerRequest(
    address: string,
    init?: { readonly body?: string; readonly headers?: HeadersInit; readonly method?: "GET" | "POST" | "PUT" },
    computerId = "computer-1",
): MortyTransportCall {
    const url = new URL(address);
    if (!url.pathname.startsWith("/morty/api/v1/computers/")) {
        url.pathname = `/morty/api/v1/computers/computer-1/harnesses/claude/sessions/session-1${url.pathname}`;
    } else {
        url.pathname = url.pathname.replace("/computers/computer/", "/computers/computer-1/");
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${sessionCredential}`);
    return {
        endpoint: {
            computerId,
            method: init?.method ?? "GET",
            path: `${url.pathname}${url.search}`,
            transport: { kind: "websocket", cancellation: "local" },
            timeoutMilliseconds: 10_000,
        },
        origin: url,
        headers: Object.fromEntries(headers.entries()),
        body: init?.body ?? null,
        signal: new AbortController().signal,
    };
}

class BrowserWebSocket extends EventTarget implements WebSocket {
    readonly CLOSED = WebSocket.CLOSED;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    binaryType: BinaryType = "blob";
    readonly bufferedAmount = 0;
    readonly extensions = "";
    onclose: WebSocket["onclose"] = null;
    onerror: WebSocket["onerror"] = null;
    onmessage: WebSocket["onmessage"] = null;
    onopen: WebSocket["onopen"] = null;
    readonly protocol = "";
    readonly liveness: "responsive" | "silent";
    readyState: WebSocket["readyState"] = WebSocket.OPEN;
    readonly subscriptionIds: string[] = [];
    readonly requestBodies: string[] = [];
    readonly responseBody: string;
    readonly url: string;
    closedWith: { readonly code: number; readonly reason: string } | null = null;

    constructor(url: string, responseBody = "", liveness: "responsive" | "silent" = "responsive") {
        super();
        this.responseBody = responseBody;
        this.url = url;
        this.liveness = liveness;
    }

    readonly close = (code = 1000, reason = ""): void => {
        if (code !== 1000 && (code < 3000 || code > 4999)) {
            throw new DOMException("The close code is reserved", "InvalidAccessError");
        }
        this.closedWith = { code, reason };
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close", { code, reason }));
    };

    readonly send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
        if (typeof data !== "string") {
            throw new Error("Expected a text WebSocket request");
        }
        const value: unknown = JSON.parse(data);
        if (typeof value !== "object" || value === null) {
            throw new Error("Expected a WebSocket message");
        }
        if ("kind" in value && value.kind === "ping") {
            if (this.liveness === "responsive") {
                queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: '{"kind":"pong"}' })));
            }
            return;
        }
        if ("subscriptionId" in value) {
            if (typeof value.subscriptionId !== "string") {
                throw new Error("Expected a string subscription identifier");
            }
            this.subscriptionIds.push(value.subscriptionId);
            queueMicrotask(() => {
                this.dispatchEvent(
                    new MessageEvent("message", {
                        data: JSON.stringify({
                            kind: "session.events.ready",
                            subscriptionId: value.subscriptionId,
                        }),
                    }),
                );
            });
            return;
        }
        if (!("requestId" in value)) {
            throw new Error("Expected a request identifier or subscription identifier");
        }
        const requestId = value.requestId;
        if (typeof requestId !== "string") {
            throw new Error("Expected a string request identifier");
        }
        if (!("body" in value) || typeof value.body !== "string") {
            throw new Error("Expected a string request body");
        }
        this.requestBodies.push(value.body);
        queueMicrotask(() => {
            this.dispatchEvent(
                new MessageEvent("message", {
                    data: JSON.stringify({
                        body: this.responseBody,
                        headers: [],
                        kind: "http.response",
                        requestId,
                        status: this.responseBody === "" ? 204 : 200,
                    }),
                }),
            );
        });
    };
}

class BrowserWebSocketConnector implements MortyWebSocketConnector {
    readonly responseBody: string;
    readonly sockets: BrowserWebSocket[] = [];
    readonly liveness: "responsive" | "silent";

    constructor(responseBody = "", liveness: "responsive" | "silent" = "responsive") {
        this.responseBody = responseBody;
        this.liveness = liveness;
    }

    readonly connect = async (endpoint: URL, signal: AbortSignal): Promise<WebSocket> => {
        signal.throwIfAborted();
        const socket = new BrowserWebSocket(endpoint.toString(), this.responseBody, this.liveness);
        this.sockets.push(socket);
        return socket;
    };
}

afterEach(() => {
    vi.useRealTimers();
});

/** A stateful wire peer for SDK recovery; the SDK owns its real connector and transport. */
async function liveEventPeer(liveness: "responsive" | "silent" = "responsive") {
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    const activeSubscriptions = new Set<string>();
    server.on("upgrade", (request, socket, head) => {
        webSockets.handleUpgrade(request, socket, head, (connection) => {
            webSockets.emit("connection", connection, request);
            connection.on("message", (data) => {
                const value: unknown = JSON.parse(data.toString());
                if (typeof value !== "object" || value === null || !("kind" in value)) {
                    throw new Error("Expected a protocol message");
                }
                if (value.kind === "ping" && liveness === "responsive") {
                    connection.send(JSON.stringify({ kind: "pong" }));
                } else if (
                    value.kind === "session.events.subscribe" &&
                    "subscriptionId" in value &&
                    typeof value.subscriptionId === "string"
                ) {
                    activeSubscriptions.add(value.subscriptionId);
                    connection.send(
                        JSON.stringify({ kind: "session.events.ready", subscriptionId: value.subscriptionId }),
                    );
                }
            });
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected a local peer address");
    }
    onTestFinished(async () => {
        for (const socket of webSockets.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve, reject) => webSockets.close((error) => (error ? reject(error) : resolve())));
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    return {
        endpoint: `http://127.0.0.1:${address.port}`,
        disconnect: async () => {
            const socket = webSockets.clients.values().next().value;
            if (socket === undefined) {
                throw new Error("Expected a connected SDK");
            }
            for (const subscriptionId of activeSubscriptions) {
                socket.send(JSON.stringify({ kind: "session.events.end", subscriptionId }));
            }
            activeSubscriptions.clear();
        },
    };
}

it("Given a browser bound to one computer, When it opens another Session or addresses another computer, Then Sessions share the connection and the other computer is rejected", async () => {
    const connector = new BrowserWebSocketConnector();
    const transport = new WsTransport({ connector });
    try {
        await transport.fetch(computerRequest("https://relay.example.test/first"));
        const events = await transport.openSessionLiveEvents(
            computerRequest(
                "https://relay.example.test/morty/api/v1/computers/computer-1/harnesses/claude/sessions/session-2/events",
            ),
        );
        expect(connector.sockets).toHaveLength(1);
        expect(connector.sockets[0]?.url).toBe("wss://relay.example.test/morty/api/v1/computers/computer-1/transport");
        await expect(
            transport.fetch(
                computerRequest(
                    "https://relay.example.test/morty/api/v1/computers/computer-2/harnesses/claude/sessions/session-1/configuration",
                    undefined,
                    "computer-2",
                ),
            ),
        ).rejects.toThrow("cannot connect to multiple computers");
        expect((await transport.fetch(computerRequest("https://relay.example.test/after-rejection"))).status).toBe(204);
        await events.cancel();
    } finally {
        transport.close();
    }
});

it("Given a quiet subscription with connection heartbeats, When minutes pass, Then its original stream still delivers events", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const connector = new BrowserWebSocketConnector("", "responsive");
    const transport = new WsTransport({ connector });
    const stream = await transport.openSessionLiveEvents(computerRequest("https://relay.example.test/session/events"));
    const reader = stream.getReader();
    try {
        await vi.advanceTimersByTimeAsync(180_000);
        const socket = connector.sockets[0];
        const subscriptionId = socket?.subscriptionIds[0];
        if (socket === undefined || subscriptionId === undefined) {
            throw new Error("Expected the live subscription");
        }
        socket.dispatchEvent(
            new MessageEvent("message", {
                data: JSON.stringify({
                    kind: "session.events.event",
                    subscriptionId,
                    seqId: 1,
                    eventId: "event-1",
                    data: "event-after-idle",
                }),
            }),
        );
        await expect(reader.read()).resolves.toEqual({
            done: false,
            value: { seqId: 1, eventId: "event-1", data: "event-after-idle" },
        });
    } finally {
        transport.close();
        reader.releaseLock();
    }
});

it("Given a transport whose peer stops answering heartbeats, When the ten-second acknowledgement deadline expires, Then the stream fails and a subsequent request reconnects", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const connector = new BrowserWebSocketConnector("", "silent");
    const transport = new WsTransport({ connector });
    const stream = await transport.openSessionLiveEvents(computerRequest("https://relay.example.test/session/events"));
    const reader = stream.getReader();
    try {
        await vi.advanceTimersByTimeAsync(20_000);
        const failed = expect(reader.read()).rejects.toBeInstanceOf(MortyConnectionError);
        await vi.advanceTimersByTimeAsync(10_000);
        await failed;
        expect((await transport.fetch(computerRequest("https://relay.example.test/after-recovery"))).status).toBe(204);
    } finally {
        transport.close();
        reader.releaseLock();
    }
});

it("Given a Unicode JSON request and response, When the browser uses the WebSocket transport, Then it transfers their text without Base64 wrapping", async () => {
    const responseBody = JSON.stringify({ message: "Olá, Morty" });
    const connector = new BrowserWebSocketConnector(responseBody);
    const transport = new WsTransport({ connector });
    const requestBody = JSON.stringify({ prompt: "show café ☕" });

    const response = await transport.fetch(
        computerRequest(
            "https://relay.example.test/morty/api/v1/computers/computer/harnesses/claude/sessions/session-1/turns",
            {
                body: requestBody,
                headers: { "content-type": "application/json" },
                method: "POST",
            },
        ),
    );

    expect(connector.sockets[0]?.requestBodies).toEqual([requestBody]);
    expect(await response.text()).toBe(responseBody);
    transport.close();
});

it("Given a replacement WebSocket carries a live subscription, When the old socket reports a delayed close, Then the replacement keeps delivering events", async () => {
    const connector = new BrowserWebSocketConnector();
    const transport = new WsTransport({ connector });

    expect((await transport.fetch(computerRequest("https://relay.example.test/first"))).status).toBe(204);
    const first = connector.sockets[0];
    if (first === undefined) {
        throw new Error("Expected the first WebSocket connection");
    }
    first.dispatchEvent(new Event("error"));
    expect((await transport.fetch(computerRequest("https://relay.example.test/second"))).status).toBe(204);
    const second = connector.sockets[1];
    if (second === undefined) {
        throw new Error("Expected the replacement WebSocket connection");
    }
    const events = await transport.openSessionLiveEvents(
        computerRequest(
            "https://relay.example.test/morty/api/v1/computers/computer/harnesses/claude/sessions/session/events",
        ),
    );
    const subscriptionId = second.subscriptionIds[0];
    if (subscriptionId === undefined) {
        throw new Error("Expected a live event subscription");
    }

    first.dispatchEvent(new CloseEvent("close", { code: 1006 }));
    second.dispatchEvent(
        new MessageEvent("message", {
            data: JSON.stringify({
                data: "event-data",
                eventId: "event-1",
                kind: "session.events.event",
                seqId: 1,
                subscriptionId,
            }),
        }),
    );

    expect(await events.getReader().read()).toEqual({
        done: false,
        value: { data: "event-data", eventId: "event-1", seqId: 1 },
    });
    expect(connector.sockets).toHaveLength(2);

    transport.close();
});

it("Given a live Session stream, When it disconnects, Then the subscription fails at once so its owner can recover", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const peer = await liveEventPeer();
    const transport = new WsTransport();
    onTestFinished(transport.close);
    const client = new MortyClient({
        transport,
        credentialProvider: {
            credential: async (signal: AbortSignal) => {
                signal.throwIfAborted();
                return sessionCredential;
            },
        },
        endpoint: peer.endpoint,
        computerId: "computer-1",
    });
    try {
        const subscription = await client.events.subscribeLive(
            { harness: "claude", sessionId: "session-1" },
            { receive: async () => true, reconcile: async () => undefined },
            new AbortController().signal,
        );
        const failure = expect(subscription.completed).rejects.toThrow("The live session event stream disconnected");
        await peer.disconnect();
        await failure;
    } finally {
        client.close();
    }
});

it("Given a live Session stream, When its peer stops answering heartbeats, Then the subscription fails so its owner can reconnect", async () => {
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const peer = await liveEventPeer("silent");
    const transport = new WsTransport();
    onTestFinished(transport.close);
    const client = new MortyClient({
        transport,
        credentialProvider: {
            credential: async (signal: AbortSignal) => {
                signal.throwIfAborted();
                return sessionCredential;
            },
        },
        endpoint: peer.endpoint,
        computerId: "computer-1",
    });
    try {
        const subscription = await client.events.subscribeLive(
            { harness: "claude", sessionId: "session-1" },
            { receive: async () => true, reconcile: async () => undefined },
            new AbortController().signal,
        );
        let outcome: unknown = "still subscribed";
        void subscription.completed.then(
            () => {
                outcome = "completed";
            },
            (cause: unknown) => {
                outcome = cause;
            },
        );

        await vi.advanceTimersByTimeAsync(30_000);

        expect(outcome).toBeInstanceOf(MortyConnectionError);
    } finally {
        client.close();
    }
});
