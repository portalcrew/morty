import { SELF } from "cloudflare:test";
import { createClientPayloadEncryption, exportE2EPublicKey, generateE2EIdentity } from "@morty-build/client";
import {
    CONTENT_CHUNK_MAX_BYTES,
    CONTENT_UPLOAD_MAX_ENCODED_BYTES,
    encodeContentChunkFrame,
    FILE_STREAM_CONTENT_TYPE,
    sessionEventsSubscribeCommandCodec,
} from "@morty-build/client/protocol";
import { expect, it, vi } from "vitest";
import { acceptWebSocketHttpTransport } from "../../src/computer-relay/components/runtime/http/websocket-http-transport.ts";
import { SessionRuntimeError } from "../../src/contracts/relay/session.ts";
import type { SubscribeSessionEvents } from "../../src/contracts/session-event-subscription.ts";
import type { WebSocketHttpOperation } from "../../src/contracts/websocket-http-dispatch.ts";
import { createOwner, issueSession, ownerOrigin, ownerRequest, pairComputer } from "./owner-fixture.ts";

class FailingDaemonBoundary {
    requests = 0;

    readonly fetch = (operation: WebSocketHttpOperation): Promise<Response> => {
        if (operation.kind === "upload-admission") {
            return Promise.resolve(new Response(null, { status: 204 }));
        }
        this.requests += 1;
        return Promise.reject(
            new SessionRuntimeError("agent_execution_failed", "The local Agent exited before completing the request"),
        );
    };
}

function nextMessage(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
        socket.addEventListener(
            "message",
            (event) => {
                if (typeof event.data !== "string") {
                    reject(new Error("Expected a text WebSocket message"));
                    return;
                }
                resolve(event.data);
            },
            { once: true },
        );
    });
}

async function subscriptionBody(subscriptionId: string, sessionId = "session"): Promise<string> {
    const computer = await generateE2EIdentity();
    const signal = new AbortController().signal;
    const sender = await createClientPayloadEncryption(
        {
            computerId: "computer-1",
            computerE2EPublicKey: await exportE2EPublicKey(computer.publicKey),
            computerE2EAccessSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        signal,
    );
    try {
        return await sessionEventsSubscribeCommandCodec.encode(
            { kind: "session.events.subscribe", subscriptionId, target: { harness: "claude", sessionId } },
            sender,
            signal,
        );
    } finally {
        sender.close();
    }
}

it("Given a browser connection, When it requests a retired private Computer API, Then the transport rejects the target rather than routing it as a supported operation", async () => {
    const computerId = "prj_ap_01_000000000000000000000001";
    const response = await SELF.fetch(`https://relay.test/morty/api/v1/computers/${computerId}/transport`, {
        headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the public WebSocket transport");
    }
    socket.accept();
    try {
        const answer = nextMessage(socket);
        socket.send(
            JSON.stringify({
                kind: "http.request",
                requestId: "retired-private-computer",
                method: "GET",
                path: `/morty/api/v1/computers/${computerId}/daemon/agents`,
                headers: [],
                body: "",
            }),
        );
        expect(JSON.parse(await answer)).toMatchObject({
            kind: "http.error",
            requestId: "retired-private-computer",
            code: "invalid_target",
            status: 400,
        });
    } finally {
        socket.close(1000, "Test complete");
    }
});

it.each([
    { operation: "unknown-command", kind: "http.response", status: 404, code: "not_found" },
    { operation: "access-credentials", kind: "http.error", status: 400, code: "invalid_target" },
    { operation: "access-credentials/unknown-command", kind: "http.error", status: 400, code: "invalid_target" },
])(
    "Given a browser connection, When it requests Session operation $operation, Then the owning route preserves its existing $status rejection",
    async ({ operation, kind, status, code }) => {
        const computerId = "prj_ap_01_000000000000000000000001";
        const response = await SELF.fetch(`https://relay.test/morty/api/v1/computers/${computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        });
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected the public WebSocket transport");
        }
        socket.accept();
        try {
            const answer = nextMessage(socket);
            socket.send(
                JSON.stringify({
                    kind: "http.request",
                    requestId: "unsupported-session-operation",
                    method: "GET",
                    path: `/morty/api/v1/computers/${computerId}/harnesses/codex/sessions/example/${operation}`,
                    headers: [["authorization", "Bearer untrusted-credential"]],
                    body: "",
                }),
            );
            const frame = JSON.parse(await answer);
            expect(frame).toMatchObject({ kind, status, requestId: "unsupported-session-operation" });
            if (kind === "http.response") {
                expect(JSON.parse(frame.body)).toMatchObject({ error: { code } });
            } else {
                expect(frame).toMatchObject({ code });
            }
        } finally {
            socket.close();
        }
    },
);

it("Given a browser connection, When it heartbeats through the public Relay transport, Then the Computer acknowledges it and an unauthenticated Session request is rejected", async () => {
    const response = await SELF.fetch(
        "https://relay.test/morty/api/v1/computers/prj_ap_01_000000000000000000000001/transport",
        {
            headers: { Upgrade: "websocket" },
        },
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the public WebSocket transport");
    }
    socket.accept();
    try {
        const heartbeat = nextMessage(socket);
        socket.send('{"kind":"ping"}');
        expect(await heartbeat).toBe('{"kind":"pong"}');
        const result = nextMessage(socket);
        socket.send(
            JSON.stringify({
                kind: "http.request",
                requestId: "after-heartbeat",
                method: "GET",
                path: "/morty/api/v1/computers/prj_ap_01_000000000000000000000001/harnesses/codex/sessions/example/active-turn",
                headers: [],
                body: "",
            }),
        );
        expect(JSON.parse(await result)).toMatchObject({
            kind: "http.error",
            requestId: "after-heartbeat",
            status: 400,
            code: "invalid_target",
        });
    } finally {
        socket.close();
    }
});

it.each([
    {
        path: "/morty/api/v1/computers/prj_ap_01_000000000000000000000002/harnesses/codex/sessions/example/active-turn",
        binary: false,
    },
    { path: "/morty/api/computers/prj_ap_01_000000000000000000000002/session", binary: false },
    { path: "/morty/api/v1/computers/prj_ap_01_000000000000000000000002/agent-settings", binary: false },
    {
        path: `/morty/api/v1/computers/prj_ap_01_000000000000000000000002/harnesses/codex/sessions/example/content/${"a".repeat(64)}`,
        binary: true,
    },
])(
    "Given a Computer-bound browser, When it addresses another computer at $path (binary: $binary), Then the request is rejected without closing the browser connection",
    async ({ path, binary }) => {
        const response = await SELF.fetch(
            "https://relay.test/morty/api/v1/computers/prj_ap_01_000000000000000000000001/transport",
            {
                headers: { Upgrade: "websocket" },
            },
        );
        expect(response.status).toBe(101);
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected the public WebSocket transport");
        }
        socket.accept();
        try {
            const result = nextMessage(socket);
            socket.send(
                JSON.stringify({
                    kind: "http.request",
                    requestId: "request-identity",
                    method: binary ? "PUT" : "GET",
                    path,
                    headers: [["authorization", "Bearer untrusted-credential"]],
                    body: "",
                    ...(binary ? { bodyByteLength: 1 } : {}),
                }),
            );
            expect(JSON.parse(await result)).toMatchObject({
                kind: "http.error",
                code: "invalid_target",
                requestId: "request-identity",
                status: 400,
            });
            const heartbeat = nextMessage(socket);
            socket.send('{"kind":"ping"}');
            expect(await heartbeat).toBe('{"kind":"pong"}');
        } finally {
            socket.close();
        }
    },
);

it("Given two browser connections to one Computer, When their pending uploads exceed its shared budget, Then the second upload is refused and capacity is released after a failed transfer", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2030-01-01T00:00:00Z") });
    const sockets: WebSocket[] = [];
    try {
        const { computerId } = await createOwner();
        await pairComputer(computerId);
        const target = { harness: "codex", sessionId: "upload-session" };
        const { credential } = await issueSession(computerId, target);
        for (let index = 0; index < 2; index += 1) {
            const response = await ownerRequest(
                new Request(`${ownerOrigin}/morty/api/v1/computers/${computerId}/transport`, {
                    headers: { Upgrade: "websocket" },
                }),
            );
            const socket = response.webSocket;
            if (socket === null) {
                throw new Error("Expected browser transports");
            }
            socket.accept();
            sockets.push(socket);
        }
        const first = sockets[0];
        const second = sockets[1];
        if (first === undefined || second === undefined) {
            throw new Error("Expected two browser transports");
        }
        const byteLength = 8 * 1024 * 1024;
        const declaration = (requestId: string) =>
            JSON.stringify({
                kind: "http.request",
                requestId,
                method: "PUT",
                path: `/morty/api/v1/computers/${computerId}/harnesses/codex/sessions/upload-session/content/${"a".repeat(64)}?uri=file:///upload.bin`,
                headers: [
                    ["authorization", `Bearer ${credential}`],
                    ["content-type", "application/octet-stream"],
                    ["x-morty-byte-length", String(byteLength)],
                    ["x-morty-content-kind", "resource"],
                    ["x-morty-file-name", "upload.bin"],
                ],
                body: "",
                bodyByteLength: byteLength,
            });
        // Admission is asynchronous. Observe which upload is refused rather than using a ping as an admission barrier.
        const refused = Promise.race([
            nextMessage(first).then((message) => ({ message, refused: first, admitted: second, admittedId: "second" })),
            nextMessage(second).then((message) => ({ message, refused: second, admitted: first, admittedId: "first" })),
        ]);
        first.send(declaration("first"));
        second.send(declaration("second"));
        const result = await refused;
        expect(JSON.parse(result.message)).toMatchObject({
            kind: "http.error",
            code: "request_capacity_exceeded",
        });
        const failed = nextMessage(result.admitted);
        result.admitted.send(
            encodeContentChunkFrame({ requestId: result.admittedId, sequence: 1, bytes: new Uint8Array([1]) }).slice()
                .buffer,
        );
        expect(JSON.parse(await failed)).toMatchObject({
            kind: "http.error",
            code: "invalid_message",
            requestId: result.admittedId,
        });
        const retried = nextMessage(result.refused);
        result.refused.send(declaration("retry"));
        for (let offset = 0, sequence = 0; offset < byteLength; offset += CONTENT_CHUNK_MAX_BYTES, sequence += 1) {
            result.refused.send(
                encodeContentChunkFrame({
                    requestId: "retry",
                    sequence,
                    bytes: new Uint8Array(Math.min(CONTENT_CHUNK_MAX_BYTES, byteLength - offset)),
                }).slice().buffer,
            );
        }
        // Reaching execution's unavailable Computer check proves admission and assembly succeeded after release.
        const response = JSON.parse(await retried);
        expect(response).toMatchObject({ kind: "http.response", requestId: "retry", status: 403 });
        expect(JSON.parse(response.body)).toMatchObject({ error: { code: "computer_access_denied" } });
    } finally {
        for (const socket of sockets) {
            socket.close();
        }
        vi.useRealTimers();
    }
});

it.each([
    { name: "missing", authorization: null, code: "invalid_target", status: 400 },
    {
        name: "malformed",
        authorization: "Bearer invalid-session-credential",
        code: "credential_invalid",
        status: 401,
    },
])(
    "Given a $name Session credential, When a browser subscribes through its WS connection, Then the DO rejects the subscription without exposing an HTTP event endpoint",
    { timeout: 5_000 },
    async ({ authorization, code, status }) => {
        const response = await SELF.fetch(
            "https://relay.test/morty/api/v1/computers/prj_wn_01_ABCDEFGHIJKLMNOPQRSTUVWX/transport",
            { headers: { Upgrade: "websocket" } },
        );
        expect(response.status).toBe(101);
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected the browser transport socket");
        }
        socket.accept();
        try {
            const subscription = JSON.stringify({
                kind: "session.events.subscribe",
                subscriptionId: "unauthorized-subscription",
                path: "/morty/api/v1/computers/prj_wn_01_ABCDEFGHIJKLMNOPQRSTUVWX/harnesses/claude/sessions/session-unauthorized/events",
                body: await subscriptionBody("unauthorized-subscription", "session-unauthorized"),
                headers: [
                    ["content-type", "application/json"],
                    ...(authorization === null ? [] : [["authorization", authorization]]),
                ],
            });
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const rejected = nextMessage(socket);
                socket.send(subscription);
                expect(JSON.parse(await rejected)).toMatchObject({ code, status });
            }
        } finally {
            socket.close(1000, "Test complete");
        }
    },
);

class SubscriptionDaemonBoundary {
    requestSignal: AbortSignal | null = null;
    readonly closed = Promise.withResolvers<void>();

    readonly fetch = (_operation: WebSocketHttpOperation): Promise<Response> => {
        throw new Error("Subscriptions must not be dispatched as HTTP requests");
    };
    readonly subscribe: SubscribeSessionEvents = async (request) => {
        this.requestSignal = request.signal;
        request.signal.addEventListener("abort", () => this.closed.resolve(), { once: true });
    };
}

class MultipleSubscriptionDaemonBoundary {
    readonly downstreams: { readonly send: (data: string) => void }[] = [];

    readonly fetch = (_operation: WebSocketHttpOperation): Promise<Response> => {
        throw new Error("Subscriptions must not be dispatched as HTTP requests");
    };
    readonly subscribe: SubscribeSessionEvents = async (request, _subscription, observer) => {
        this.downstreams.push({
            send: (data) => {
                if (!request.signal.aborted) {
                    observer.message(data);
                }
            },
        });
    };
}

it("Given two quiet subscriptions, When multiple heartbeat intervals pass, Then one connection heartbeat suffices and both subscriptions still deliver", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const daemon = new MultipleSubscriptionDaemonBoundary();
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        dispatch: daemon.fetch,
        subscribe: daemon.subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport");
    }
    socket.accept();
    try {
        for (const subscriptionId of ["first-stream", "second-stream"]) {
            const ready = nextMessage(socket);
            socket.send(
                JSON.stringify({
                    kind: "session.events.subscribe",
                    subscriptionId,
                    path: "/morty/api/v1/computers/computer/harnesses/claude/sessions/session/events",
                    body: await subscriptionBody(subscriptionId),
                    headers: [["content-type", "application/json"]],
                }),
            );
            expect(JSON.parse(await ready)).toEqual({
                kind: "session.events.ready",
                subscriptionId,
            });
        }
        for (let interval = 0; interval < 4; interval += 1) {
            const heartbeat = nextMessage(socket);
            await vi.advanceTimersByTimeAsync(20_000);
            socket.send('{"kind":"ping"}');
            expect(await heartbeat).toBe('{"kind":"pong"}');
        }
        for (const [index, downstream] of daemon.downstreams.entries()) {
            const delivered = nextMessage(socket);
            downstream.send(`stream-${index}`);
            expect(JSON.parse(await delivered)).toMatchObject({
                kind: "session.events.event",
                data: `stream-${index}`,
                subscriptionId: index === 0 ? "first-stream" : "second-stream",
            });
        }
    } finally {
        socket.close();
        vi.useRealTimers();
    }
});

class PendingDaemonBoundary {
    readonly response = Promise.withResolvers<Response>();
    readonly requested = Promise.withResolvers<AbortSignal>();

    readonly fetch = (operation: WebSocketHttpOperation): Promise<Response> => {
        this.requested.resolve(operation.request.signal);
        return this.response.promise;
    };
}

class TextDaemonBoundary {
    requestBody: string | null = null;
    readonly responseBody: string;

    constructor(responseBody: string) {
        this.responseBody = responseBody;
    }

    readonly fetch = async (operation: WebSocketHttpOperation): Promise<Response> => {
        if (operation.kind === "upload-admission") {
            return new Response(null, { status: 204 });
        }
        this.requestBody = await operation.request.text();
        return new Response(this.responseBody, { headers: { "content-type": "application/json" } });
    };
}

it("Given a Unicode JSON request and response, When the relay carries them over WebSocket, Then it transfers their text without Base64 wrapping", async () => {
    const requestBody = JSON.stringify({ prompt: "show café ☕" });
    const responseBody = JSON.stringify({ message: "Olá, Morty" });
    const daemon = new TextDaemonBoundary(responseBody);
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        dispatch: daemon.fetch,
        subscribe: new SubscriptionDaemonBoundary().subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const message = nextMessage(socket);

    socket.send(
        JSON.stringify({
            body: requestBody,
            headers: [["content-type", "application/json"]],
            kind: "http.request",
            method: "POST",
            path: "/morty/api/v1/computers/computer/sessions",
            requestId: "text-body",
        }),
    );

    expect(JSON.parse(await message)).toEqual({
        body: responseBody,
        headers: [["content-type", "application/json"]],
        kind: "http.response",
        requestId: "text-body",
        status: 200,
    });
    expect(daemon.requestBody).toBe(requestBody);
    socket.close();
});

it("Given an invalid binary declaration, When the request ID is reused for a valid upload, Then validation happens before buffering", async () => {
    const daemon = new TextDaemonBoundary("uploaded");
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", { headers: { Upgrade: "websocket" } }),
        dispatch: daemon.fetch,
        subscribe: new SubscriptionDaemonBoundary().subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const invalid = nextMessage(socket);
    socket.send(
        JSON.stringify({
            body: "",
            bodyByteLength: 1,
            headers: [],
            kind: "http.request",
            method: "POST",
            path: "/outside/morty",
            requestId: "reused-upload",
        }),
    );
    expect(JSON.parse(await invalid)).toMatchObject({ code: "invalid_target", requestId: "reused-upload" });

    const uploaded = nextMessage(socket);
    socket.send(
        JSON.stringify({
            body: "",
            bodyByteLength: 1,
            headers: [],
            kind: "http.request",
            method: "POST",
            path: "/morty/api/v1/computers/computer/sessions",
            requestId: "reused-upload",
        }),
    );
    socket.send(
        encodeContentChunkFrame({ bytes: new TextEncoder().encode("x"), requestId: "reused-upload", sequence: 0 }),
    );
    expect(JSON.parse(await uploaded)).toMatchObject({
        body: "uploaded",
        kind: "http.response",
        requestId: "reused-upload",
        status: 200,
    });
    expect(daemon.requestBody).toBe("x");
    socket.close();
});

it("Given a binary upload sends an invalid chunk, When it retries the same request ID, Then the failed buffer was released", async () => {
    const daemon = new TextDaemonBoundary("uploaded");
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", { headers: { Upgrade: "websocket" } }),
        dispatch: daemon.fetch,
        subscribe: new SubscriptionDaemonBoundary().subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const declaration = {
        body: "",
        bodyByteLength: 1,
        headers: [],
        kind: "http.request",
        method: "POST",
        path: "/morty/api/v1/computers/computer/sessions",
        requestId: "retry-upload",
    };
    const invalid = nextMessage(socket);
    socket.send(JSON.stringify(declaration));
    socket.send(
        encodeContentChunkFrame({ bytes: new TextEncoder().encode("x"), requestId: "retry-upload", sequence: 1 }),
    );
    expect(JSON.parse(await invalid)).toMatchObject({ code: "invalid_message", requestId: "retry-upload" });

    const uploaded = nextMessage(socket);
    socket.send(JSON.stringify(declaration));
    socket.send(
        encodeContentChunkFrame({ bytes: new TextEncoder().encode("x"), requestId: "retry-upload", sequence: 0 }),
    );
    expect(JSON.parse(await uploaded)).toMatchObject({ kind: "http.response", requestId: "retry-upload", status: 200 });
    socket.close();
});

it("Given an incomplete upload consumes the aggregate byte budget, When its deadline passes, Then capacity is released", async () => {
    vi.useFakeTimers();
    try {
        const daemon = new TextDaemonBoundary("uploaded");
        const response = acceptWebSocketHttpTransport({
            request: new Request("https://relay.test/morty/api/v1/transport", {
                headers: { Upgrade: "websocket" },
            }),
            dispatch: daemon.fetch,
            subscribe: new SubscriptionDaemonBoundary().subscribe,
        });
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected a WebSocket transport response");
        }
        socket.accept();
        socket.send(
            JSON.stringify({
                body: "",
                bodyByteLength: 12_582_912,
                headers: [],
                kind: "http.request",
                method: "POST",
                path: "/morty/api/v1/computers/computer/sessions",
                requestId: "abandoned-upload",
            }),
        );
        const overloaded = nextMessage(socket);
        socket.send(
            JSON.stringify({
                body: "",
                bodyByteLength: 1,
                headers: [],
                kind: "http.request",
                method: "POST",
                path: "/morty/api/v1/computers/computer/sessions",
                requestId: "next-upload",
            }),
        );
        expect(JSON.parse(await overloaded)).toMatchObject({
            code: "request_capacity_exceeded",
            requestId: "next-upload",
            status: 429,
        });

        const expired = nextMessage(socket);
        await vi.advanceTimersByTimeAsync(30_001);
        expect(JSON.parse(await expired)).toMatchObject({
            code: "request_timeout",
            requestId: "abandoned-upload",
            status: 408,
        });

        const uploaded = nextMessage(socket);
        socket.send(
            JSON.stringify({
                body: "",
                bodyByteLength: 1,
                headers: [],
                kind: "http.request",
                method: "POST",
                path: "/morty/api/v1/computers/computer/sessions",
                requestId: "next-upload",
            }),
        );
        socket.send(
            encodeContentChunkFrame({ bytes: new TextEncoder().encode("x"), requestId: "next-upload", sequence: 0 }),
        );
        expect(JSON.parse(await uploaded)).toMatchObject({
            kind: "http.response",
            requestId: "next-upload",
            status: 200,
        });
        socket.close();
    } finally {
        vi.useRealTimers();
    }
});

it("Given binary requests, when their declared sizes exceed their owning limits, then ordinary requests and encrypted uploads are both refused", async () => {
    const daemon = new TextDaemonBoundary("uploaded");
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", { headers: { Upgrade: "websocket" } }),
        dispatch: daemon.fetch,
        subscribe: new SubscriptionDaemonBoundary().subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const ordinary = nextMessage(socket);
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "ordinary-too-large",
            method: "POST",
            path: "/morty/api/v1/computers/computer/sessions",
            headers: [],
            body: "",
            bodyByteLength: 12_582_913,
        }),
    );
    expect(JSON.parse(await ordinary)).toMatchObject({
        code: "invalid_message",
        requestId: "ordinary-too-large",
        status: 400,
    });
    const upload = nextMessage(socket);
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "encrypted-too-large",
            method: "PUT",
            path: `/morty/api/v1/computers/computer/harnesses/codex/sessions/session/content/${"a".repeat(64)}`,
            headers: [["content-type", FILE_STREAM_CONTENT_TYPE]],
            body: "",
            bodyByteLength: CONTENT_UPLOAD_MAX_ENCODED_BYTES + 1,
        }),
    );
    expect(JSON.parse(await upload)).toMatchObject({
        code: "invalid_message",
        requestId: "encrypted-too-large",
        status: 400,
    });
    socket.close();
});

it("Given many incomplete binary uploads, When their count reaches the pending limit, Then another declaration is rejected", async () => {
    const daemon = new TextDaemonBoundary("unused");
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", { headers: { Upgrade: "websocket" } }),
        dispatch: daemon.fetch,
        subscribe: new SubscriptionDaemonBoundary().subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    for (let index = 0; index < 16; index += 1) {
        socket.send(
            JSON.stringify({
                body: "",
                bodyByteLength: 1,
                headers: [],
                kind: "http.request",
                method: "POST",
                path: "/morty/api/v1/computers/computer/sessions",
                requestId: `pending-${index}`,
            }),
        );
    }
    const overloaded = nextMessage(socket);
    socket.send(
        JSON.stringify({
            body: "",
            bodyByteLength: 1,
            headers: [],
            kind: "http.request",
            method: "POST",
            path: "/morty/api/v1/computers/computer/sessions",
            requestId: "pending-overflow",
        }),
    );
    expect(JSON.parse(await overloaded)).toMatchObject({
        code: "request_capacity_exceeded",
        requestId: "pending-overflow",
        status: 429,
    });
    socket.close();
});

it("Given a daemon request fails with a 5XX error, When the WebSocket transport reports it, Then the client receives its detailed code and message", async () => {
    const daemon = new FailingDaemonBoundary();
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        dispatch: daemon.fetch,
        subscribe: new SubscriptionDaemonBoundary().subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const message = nextMessage(socket);

    socket.send(
        JSON.stringify({
            body: "",
            headers: [],
            kind: "http.request",
            method: "GET",
            path: "/morty/api/v1/events",
            requestId: "daemon-failure",
        }),
    );

    expect(JSON.parse(await message)).toEqual({
        code: "agent_execution_failed",
        kind: "http.error",
        message: "The local Agent exited before completing the request",
        requestId: "daemon-failure",
        status: 503,
    });
    expect(daemon.requests).toBe(1);
    socket.close();
});

it("Given an established event subscription, When the browser transport closes, Then its subscription is cancelled without an internal HTTP upgrade", async () => {
    const daemon = new SubscriptionDaemonBoundary();
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        dispatch: daemon.fetch,
        subscribe: daemon.subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    const ready = nextMessage(socket);
    socket.send(
        JSON.stringify({
            body: await subscriptionBody("subscription-1"),
            headers: [["content-type", "application/json"]],
            kind: "session.events.subscribe",
            path: "/morty/api/v1/computers/computer/harnesses/claude/sessions/session/events",
            subscriptionId: "subscription-1",
        }),
    );
    expect(JSON.parse(await ready)).toMatchObject({
        kind: "session.events.ready",
        subscriptionId: "subscription-1",
    });
    const requestSignal = daemon.requestSignal;
    if (requestSignal === null) {
        throw new Error("Expected an established downstream subscription");
    }

    socket.close(1000, "Browser transport closed");

    await daemon.closed.promise;
    expect(requestSignal.aborted).toBe(true);
});

it("Given two live subscriptions, When each receives event batches, Then delivery sequence IDs start at one and advance per subscription", async () => {
    const daemon = new MultipleSubscriptionDaemonBoundary();
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        dispatch: daemon.fetch,
        subscribe: daemon.subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    for (const subscriptionId of ["subscription-1", "subscription-2"]) {
        const ready = nextMessage(socket);
        socket.send(
            JSON.stringify({
                body: await subscriptionBody(subscriptionId, subscriptionId),
                headers: [["content-type", "application/json"]],
                kind: "session.events.subscribe",
                path: `/morty/api/v1/computers/computer/harnesses/claude/sessions/${subscriptionId}/events`,
                subscriptionId,
            }),
        );
        expect(JSON.parse(await ready)).toMatchObject({ kind: "session.events.ready", subscriptionId });
    }
    const first = daemon.downstreams[0];
    const second = daemon.downstreams[1];
    if (first === undefined || second === undefined) {
        throw new Error("Expected two downstream subscriptions");
    }

    let delivered = nextMessage(socket);
    first.send("first batch");
    expect(JSON.parse(await delivered)).toEqual({
        data: "first batch",
        eventId: "",
        kind: "session.events.event",
        seqId: 1,
        subscriptionId: "subscription-1",
    });
    delivered = nextMessage(socket);
    first.send("second batch");
    expect(JSON.parse(await delivered)).toEqual({
        data: "second batch",
        eventId: "",
        kind: "session.events.event",
        seqId: 2,
        subscriptionId: "subscription-1",
    });
    delivered = nextMessage(socket);
    second.send("independent batch");
    expect(JSON.parse(await delivered)).toEqual({
        data: "independent batch",
        eventId: "",
        kind: "session.events.event",
        seqId: 1,
        subscriptionId: "subscription-2",
    });
    socket.close(1000, "Test complete");
});

it("Given an established event subscription is quiet, When the transport idle deadline passes, Then the browser remains connected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T00:00:00.000Z"));
    try {
        const daemon = new SubscriptionDaemonBoundary();
        const response = acceptWebSocketHttpTransport({
            request: new Request("https://relay.test/morty/api/v1/transport", {
                headers: { Upgrade: "websocket" },
            }),
            dispatch: daemon.fetch,
            subscribe: daemon.subscribe,
        });
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected a WebSocket transport response");
        }
        socket.accept();
        const ready = nextMessage(socket);
        socket.send(
            JSON.stringify({
                body: await subscriptionBody("subscription-1"),
                headers: [["content-type", "application/json"]],
                kind: "session.events.subscribe",
                path: "/morty/api/v1/computers/computer/harnesses/claude/sessions/session/events",
                subscriptionId: "subscription-1",
            }),
        );
        expect(JSON.parse(await ready)).toMatchObject({
            kind: "session.events.ready",
            subscriptionId: "subscription-1",
        });

        for (let interval = 0; interval < 4; interval += 1) {
            const heartbeat = nextMessage(socket);
            await vi.advanceTimersByTimeAsync(20_000);
            socket.send('{"kind":"ping"}');
            expect(await heartbeat).toBe('{"kind":"pong"}');
        }
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close(1000, "Test complete");
    } finally {
        vi.useRealTimers();
    }
});

it("Given a finite request is in flight, When the browser transport closes, Then the dispatched request can finish without disconnecting its downstream transport", async () => {
    const daemon = new PendingDaemonBoundary();
    const response = acceptWebSocketHttpTransport({
        request: new Request("https://relay.test/morty/api/v1/transport", {
            headers: { Upgrade: "websocket" },
        }),
        dispatch: daemon.fetch,
        subscribe: new SubscriptionDaemonBoundary().subscribe,
    });
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket transport response");
    }
    socket.accept();
    socket.send(
        JSON.stringify({
            body: "",
            headers: [],
            kind: "http.request",
            method: "GET",
            path: "/morty/api/v1/computers/computer/daemon/agents",
            requestId: "pending-request",
        }),
    );
    const requestSignal = await daemon.requested.promise;

    socket.close(1000, "Browser transport closed");
    daemon.response.resolve(Response.json({ agents: [] }));

    expect(requestSignal.aborted).toBe(false);
});
