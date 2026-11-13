import { abortAllDurableObjects } from "cloudflare:test";
import {
    createClientPayloadEncryption,
    createComputerPayloadEncryption,
    exportE2EPublicKey,
    generateE2EIdentity,
    type PayloadEncryptionConnection,
} from "@morty-build/client";
import {
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    computerCredentialSuccessor,
    decodeSessionEventEnvelope,
    type NativeSessionTarget,
    nativeSessionCommandCodec,
    nativeSessionResultCodec,
    sessionCloseNoticeEventCodec,
    sessionConfigReadCommandCodec,
    sessionEventEnvelopeCodec,
    sessionEventsSubscribeCommandCodec,
    sessionInteractionAnsweredEventCodec,
    sessionOperationFailedEventCodec,
    sessionPermissionRespondCommandCodec,
    sessionPromptAcceptedEventCodec,
    sessionPromptCommandCodec,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { closeBrowserSocket } from "./browser-session.ts";
import { createOwner, issueSession, ownerOrigin, ownerRequest, pairComputer } from "./owner-fixture.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2030-01-01T00:00:00Z") }));
afterEach(() => vi.useRealTimers());
afterAll(() => abortAllDurableObjects());

class Inbox {
    readonly #pending: PromiseWithResolvers<unknown>[] = [];
    readonly #queued: unknown[] = [];
    readonly send: (message: string) => void;
    readonly close: () => void;
    constructor(socket: WebSocket) {
        this.send = (message) => socket.send(message);
        this.close = () => socket.close(1000, "Browser closed");
        socket.addEventListener("message", (event) => {
            const message: unknown = JSON.parse(String(event.data));
            const pending = this.#pending.shift();
            if (pending === undefined) {
                this.#queued.push(message);
            } else {
                pending.resolve(message);
            }
        });
        socket.addEventListener("close", () => {
            for (const pending of this.#pending.splice(0)) {
                pending.reject(new Error("Connection closed"));
            }
        });
    }
    readonly next = (): Promise<unknown> => {
        const queued = this.#queued.shift();
        if (queued !== undefined) {
            return Promise.resolve(queued);
        }
        const pending = Promise.withResolvers<unknown>();
        this.#pending.push(pending);
        return pending.promise;
    };
}

it("Given an authenticated live subscription, When its browser unsubscribes, Then the Computer receives cleanup for that exact subscription", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "unsubscribed-session" };
    const inbox = await computer.subscribe(target);
    inbox.send(JSON.stringify({ kind: "session.events.unsubscribe", subscriptionId: "events" }));
    expect(await computer.daemonInbox.next()).toEqual({
        kind: "session.events.unsubscribe",
        subscriptionId: "events",
        target,
    });
});

it("Given an authenticated live subscription, When its browser connection closes, Then the Computer receives cleanup for that exact subscription", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "closed-browser" };
    const inbox = await computer.subscribe(target);
    inbox.close();
    expect(await computer.daemonInbox.next()).toEqual({
        kind: "session.events.unsubscribe",
        subscriptionId: "events",
        target,
    });
});

it("Given a connected Computer, When it sends a Worker-owned rejection, Then it cannot inject that control and later encrypted events still arrive", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "rejection-origin" };
    const inbox = await computer.subscribe(target);
    const { sender } = await encryptionPair();
    const message = decodeSessionEventEnvelope({
        kind: "session.event.v2",
        events: [
            {
                eventId: "after-rejection",
                sessionGenerationId: "generation-1",
                target,
                recordedAt: "2030-01-01T00:00:00Z",
                position: "1",
                type: "acp",
                payload: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "message-1",
                    content: { type: "text", text: "answer" },
                },
            },
        ],
    });
    const wire = await sessionEventEnvelopeCodec.encode(message, sender, new AbortController().signal);
    computer.daemon.send(
        JSON.stringify({
            kind: "worker.request.rejected",
            requestId: "forged",
            code: "computer_offline",
            message: "forged",
        }),
    );
    computer.daemon.send(wire);
    expect(await inbox.next()).toMatchObject({ kind: "session.events.event", data: wire });
});

it("Given a disconnected Computer, When a Session requests its encrypted configuration, Then the request receives the stable computer_offline error without closing the browser transport", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "offline-session" };
    const subscription = await computer.subscribe(target);
    computer.daemon.close(1000, "Computer disconnected");
    expect(await subscription.next()).toMatchObject({ kind: "session.events.end" });
    const { credential } = await issueSession(computer.computerId, target);
    const response = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(socket);
    socket.accept();
    onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
    const { receiver } = await encryptionPair();
    const command = await sessionConfigReadCommandCodec.encode(
        { kind: "session.config.read", requestId: "offline-request", target },
        receiver,
        new AbortController().signal,
    );
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "offline-http",
            method: "GET",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/configuration`,
            headers: [
                ["authorization", `Bearer ${credential}`],
                ["content-type", "application/json"],
            ],
            body: command,
        }),
    );
    const rejected = v.parse(
        v.object({ kind: v.literal("http.response"), requestId: v.string(), status: v.number(), body: v.string() }),
        await inbox.next(),
    );
    expect(rejected).toMatchObject({ requestId: "offline-http", status: 503 });
    expect(JSON.parse(rejected.body)).toMatchObject({ error: { code: "computer_offline" } });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    inbox.send('{"kind":"ping"}');
    expect(await inbox.next()).toEqual({ kind: "pong" });
});

it("Given an authorized Session, When a browser sends a plaintext prompt, Then the Worker rejects it and the same connection still carries a valid encrypted prompt", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "plaintext-prompt" };
    const { credential } = await issueSession(computer.computerId, target);
    const opened = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const socket = opened.webSocket;
    if (socket === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(socket);
    socket.accept();
    onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
    const path = `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/turns`;
    const headers = [
        ["authorization", `Bearer ${credential}`],
        ["content-type", "application/json"],
    ];
    const plaintext = {
        kind: "session.prompt",
        requestId: "plaintext-request",
        commandId: "plaintext-1",
        target,
        prompt: "private prompt",
        attachments: [],
        disposition: "append",
    };
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "plaintext-http",
            method: "POST",
            path,
            headers,
            body: JSON.stringify(plaintext),
        }),
    );
    expect(await inbox.next()).toMatchObject({ kind: "http.response", requestId: "plaintext-http", status: 400 });
    const { sender, receiver } = await encryptionPair();
    const signal = new AbortController().signal;
    const command = await sessionPromptCommandCodec.encode(
        { ...plaintext, commandId: "encrypted-1", requestId: "encrypted-request" },
        receiver,
        signal,
    );
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "encrypted-http",
            method: "POST",
            path,
            headers,
            body: command,
        }),
    );
    expect(await computer.daemonInbox.next()).toEqual(JSON.parse(command));
    const reply = await sessionPromptAcceptedEventCodec.encode(
        { kind: "session.prompt.accepted", requestId: "encrypted-request", target, state: "running" },
        sender,
        signal,
    );
    computer.daemon.send(reply);
    const result = v.parse(
        v.object({ kind: v.literal("http.response"), requestId: v.string(), status: v.number(), body: v.string() }),
        await inbox.next(),
    );
    expect(result).toMatchObject({ requestId: "encrypted-http", status: 200 });
    expect(JSON.parse(result.body)).toEqual(JSON.parse(reply));
});

it("Given a Session credential, When the browser sends an encrypted GET command in its transport body, Then the Computer receives it and the correlated encrypted reply returns unchanged", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "settings-session" };
    const { credential } = await issueSession(computer.computerId, target);
    const response = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(socket);
    socket.accept();
    onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
    const { sender, receiver } = await encryptionPair();
    const signal = new AbortController().signal;
    const command = await sessionConfigReadCommandCodec.encode(
        { kind: "session.config.read", requestId: "config-1", target },
        receiver,
        signal,
    );
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "http-1",
            method: "GET",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/configuration`,
            headers: [
                ["authorization", `Bearer ${credential}`],
                ["content-type", "application/json"],
            ],
            body: command,
        }),
    );
    expect(await computer.daemonInbox.next()).toEqual(JSON.parse(command));
    const reply = await sessionOperationFailedEventCodec.encode(
        {
            kind: "session.operation.failed",
            requestId: "config-1",
            target,
            code: "agent_execution_failed",
            message: "Private failure",
        },
        sender,
        signal,
    );
    computer.daemon.send(reply);
    const received = v.parse(
        v.object({ kind: v.literal("http.response"), requestId: v.string(), body: v.string() }),
        await inbox.next(),
    );
    expect(received.requestId).toBe("http-1");
    expect(JSON.parse(received.body)).toEqual(JSON.parse(reply));
});

it("Given an in-flight request ID, When another Session reuses it, Then the Worker rejects only the duplicate and permits a later retry", async () => {
    const computer = await connectedComputer();
    const signal = new AbortController().signal;
    const first = { harness: "claude", sessionId: "collision-first" };
    const second = { harness: "codex", sessionId: "collision-second" };
    const open = async (target: NativeSessionTarget) => {
        const { credential } = await issueSession(computer.computerId, target);
        const response = await ownerRequest(
            new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
                headers: { Upgrade: "websocket" },
            }),
        );
        const socket = response.webSocket;
        if (socket === null) {
            throw new Error("Expected the browser transport");
        }
        const inbox = new Inbox(socket);
        socket.accept();
        onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
        return {
            inbox,
            send: (requestId: string, body: string) =>
                socket.send(
                    JSON.stringify({
                        kind: "http.request",
                        requestId,
                        method: "GET",
                        path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/configuration`,
                        headers: [
                            ["authorization", `Bearer ${credential}`],
                            ["content-type", "application/json"],
                        ],
                        body,
                    }),
                ),
        };
    };
    const firstBrowser = await open(first);
    const secondBrowser = await open(second);
    const firstCrypto = await encryptionPair();
    const secondCrypto = await encryptionPair();
    const independentCrypto = await encryptionPair();
    const firstCommand = await sessionConfigReadCommandCodec.encode(
        { kind: "session.config.read", requestId: "shared-request", target: first },
        firstCrypto.receiver,
        signal,
    );
    const duplicateCommand = await sessionConfigReadCommandCodec.encode(
        { kind: "session.config.read", requestId: "shared-request", target: second },
        secondCrypto.receiver,
        signal,
    );
    firstBrowser.send("first-http", firstCommand);
    expect(await computer.daemonInbox.next()).toEqual(JSON.parse(firstCommand));
    const nextDaemonMessage = computer.daemonInbox.next();
    firstBrowser.send("same-retry-http", firstCommand);
    const sameRetry = await Promise.race([
        nextDaemonMessage.then((value) => ({ kind: "daemon", value })),
        firstBrowser.inbox.next().then((value) => ({ kind: "browser", value })),
    ]);
    expect(sameRetry).toMatchObject({
        kind: "browser",
        value: { kind: "http.response", requestId: "same-retry-http", status: 409 },
    });
    if (sameRetry.kind !== "browser") {
        throw new Error("Concurrent retry reached the Computer");
    }
    const retryRejected = v.parse(v.object({ body: v.string() }), sameRetry.value);
    expect(JSON.parse(retryRejected.body)).toMatchObject({ error: { code: "session_busy" } });
    secondBrowser.send("duplicate-http", duplicateCommand);
    const duplicateResponse = secondBrowser.inbox.next();
    const firstAfterDuplicate = await Promise.race([
        nextDaemonMessage.then((value) => ({ kind: "daemon", value })),
        duplicateResponse.then((value) => ({ kind: "browser", value })),
    ]);
    expect(firstAfterDuplicate).toMatchObject({
        kind: "browser",
        value: { kind: "http.response", requestId: "duplicate-http", status: 409 },
    });
    if (firstAfterDuplicate.kind !== "browser") {
        throw new Error("Duplicate reached the Computer");
    }
    const rejected = v.parse(v.object({ body: v.string() }), firstAfterDuplicate.value);
    expect(JSON.parse(rejected.body)).toMatchObject({ error: { code: "session_busy" } });
    const independent = await sessionConfigReadCommandCodec.encode(
        { kind: "session.config.read", requestId: "independent", target: second },
        independentCrypto.receiver,
        signal,
    );
    secondBrowser.send("independent-http", independent);
    expect(await nextDaemonMessage).toEqual(JSON.parse(independent));
    const independentReply = await sessionOperationFailedEventCodec.encode(
        {
            kind: "session.operation.failed",
            requestId: "independent",
            target: second,
            code: "agent_execution_failed",
            message: "second private error",
        },
        independentCrypto.sender,
        signal,
    );
    computer.daemon.send(independentReply);
    const frame = v.object({ kind: v.literal("http.response"), requestId: v.string(), body: v.string() });
    const secondResponse = v.parse(frame, await secondBrowser.inbox.next());
    expect(secondResponse.requestId).toBe("independent-http");
    expect(JSON.parse(secondResponse.body)).toEqual(JSON.parse(independentReply));
    const firstReply = await sessionOperationFailedEventCodec.encode(
        {
            kind: "session.operation.failed",
            requestId: "shared-request",
            target: first,
            code: "agent_execution_failed",
            message: "first private error",
        },
        firstCrypto.sender,
        signal,
    );
    computer.daemon.send(firstReply);
    const firstResponse = v.parse(frame, await firstBrowser.inbox.next());
    expect(firstResponse.requestId).toBe("first-http");
    expect(JSON.parse(firstResponse.body)).toEqual(JSON.parse(firstReply));
    secondBrowser.send("retry-http", duplicateCommand);
    expect(await computer.daemonInbox.next()).toEqual(JSON.parse(duplicateCommand));
    const retryReply = await sessionOperationFailedEventCodec.encode(
        {
            kind: "session.operation.failed",
            requestId: "shared-request",
            target: second,
            code: "agent_execution_failed",
            message: "retry private error",
        },
        secondCrypto.sender,
        signal,
    );
    computer.daemon.send(retryReply);
    const retryResponse = v.parse(frame, await secondBrowser.inbox.next());
    expect(retryResponse.requestId).toBe("retry-http");
    expect(JSON.parse(retryResponse.body)).toEqual(JSON.parse(retryReply));
});

it("Given a Session credential and pending interaction, When the browser sends its encrypted answer, Then the Computer receives only the addressed command and the browser receives its encrypted reply", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "interaction-session" };
    const { credential } = await issueSession(computer.computerId, target);
    const response = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(socket);
    socket.accept();
    onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
    const wrong = await encryptionPair();
    const wrongCommand = await sessionPermissionRespondCommandCodec.encode(
        {
            kind: "session.permission.respond",
            requestId: "wrong-answer",
            interactionId: "other-interaction",
            target,
            outcome: "selected",
            optionId: "allow",
        },
        wrong.receiver,
        new AbortController().signal,
    );
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "wrong-http",
            method: "POST",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/interactions/interaction-1/responses`,
            headers: [
                ["authorization", `Bearer ${credential}`],
                ["content-type", "application/json"],
            ],
            body: wrongCommand,
        }),
    );
    expect(await inbox.next()).toMatchObject({ kind: "http.response", requestId: "wrong-http", status: 400 });
    const { sender, receiver } = await encryptionPair();
    const signal = new AbortController().signal;
    const command = await sessionPermissionRespondCommandCodec.encode(
        {
            kind: "session.permission.respond",
            requestId: "answer-1",
            interactionId: "interaction-1",
            target,
            outcome: "selected",
            optionId: "allow",
        },
        receiver,
        signal,
    );
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "http-answer",
            method: "POST",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/interactions/interaction-1/responses`,
            headers: [
                ["authorization", `Bearer ${credential}`],
                ["content-type", "application/json"],
            ],
            body: command,
        }),
    );
    const browserReply = inbox.next();
    const first = await Promise.race([
        computer.daemonInbox.next().then((value) => ({ kind: "daemon", value })),
        browserReply.then((value) => ({ kind: "browser", value })),
    ]);
    expect(first).toEqual({ kind: "daemon", value: JSON.parse(command) });
    const reply = await sessionInteractionAnsweredEventCodec.encode(
        { kind: "session.interaction.answered", requestId: "answer-1", interactionId: "interaction-1", target },
        sender,
        signal,
    );
    computer.daemon.send(reply);
    const received = v.parse(
        v.object({ kind: v.literal("http.response"), requestId: v.string(), body: v.string() }),
        await browserReply,
    );
    expect(received.requestId).toBe("http-answer");
    expect(JSON.parse(received.body)).toEqual(JSON.parse(reply));
});

it("Given a Session credential, When the browser requests its encrypted active Turn, Then the Computer receives the addressed request and the browser receives its encrypted reply", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "active-session" };
    const { credential } = await issueSession(computer.computerId, target);
    const response = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(socket);
    socket.accept();
    onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
    const other = await encryptionPair();
    const wrong = await nativeSessionCommandCodec.encode(
        {
            kind: "native.session.request",
            requestId: "wrong-active",
            action: "active-turn",
            target: { harness: "codex", sessionId: target.sessionId },
        },
        other.receiver,
        new AbortController().signal,
    );
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "wrong-active-http",
            method: "GET",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/active-turn`,
            headers: [
                ["authorization", `Bearer ${credential}`],
                ["content-type", "application/json"],
            ],
            body: wrong,
        }),
    );
    expect(await inbox.next()).toMatchObject({ kind: "http.response", requestId: "wrong-active-http", status: 400 });
    const { sender, receiver } = await encryptionPair();
    const signal = new AbortController().signal;
    const command = await nativeSessionCommandCodec.encode(
        {
            kind: "native.session.request",
            requestId: "active-1",
            action: "active-turn",
            target,
            deliveryCommandId: "delivery-1",
        },
        receiver,
        signal,
    );
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "http-active",
            method: "GET",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/active-turn?commandId=delivery-1`,
            headers: [
                ["authorization", `Bearer ${credential}`],
                ["content-type", "application/json"],
            ],
            body: command,
        }),
    );
    const browserReply = inbox.next();
    const first = await Promise.race([
        computer.daemonInbox.next().then((value) => ({ kind: "daemon", value })),
        browserReply.then((value) => ({ kind: "browser", value })),
    ]);
    expect(first).toEqual({ kind: "daemon", value: JSON.parse(command) });
    const reply = await sessionOperationFailedEventCodec.encode(
        {
            kind: "session.operation.failed",
            requestId: "active-1",
            target,
            code: "agent_execution_failed",
            message: "Private failure",
        },
        sender,
        signal,
    );
    computer.daemon.send(reply);
    const received = v.parse(
        v.object({ kind: v.literal("http.response"), requestId: v.string(), body: v.string() }),
        await browserReply,
    );
    expect(received.requestId).toBe("http-active");
    expect(JSON.parse(received.body)).toEqual(JSON.parse(reply));
});

it("Given an authorized native Fork, When the Computer returns a new Session, Then only a matching harness destination answers the Fork", async () => {
    const computer = await connectedComputer();
    const signal = new AbortController().signal;
    const operationId = "fork-routing";
    const digest = new Uint8Array(
        await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`${computer.computerId}\u0000fork\u0000${operationId}`),
        ),
    );
    const requestId = `chat_${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const encryption = await encryptionPair();
    const encoded = await nativeSessionCommandCodec.encode(
        {
            kind: "native.session.request",
            action: "fork",
            requestId,
            harness: "claude",
            sessionId: "source-session",
            directory: ".",
        },
        encryption.receiver,
        signal,
    );
    const response = ownerRequest(
        new Request(
            `${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/native-sessions/forks/${operationId}`,
            {
                method: "POST",
                headers: { authorization: `Bearer ${computer.ownerToken}`, "content-type": "application/json" },
                body: encoded,
                signal,
            },
        ),
    );
    expect(await computer.daemonInbox.next()).toEqual(JSON.parse(encoded));
    const forkResult = async (harness: string, sessionId: string) => {
        const target = { harness, sessionId };
        return await nativeSessionResultCodec.encode(
            {
                kind: "native.session.result",
                action: "fork",
                requestId,
                target,
                title: "Fork",
                ready: {
                    kind: "session.ready",
                    requestId,
                    target,
                    harness,
                    agentName: "Agent",
                    agentVersion: "1",
                    capabilities: {
                        audioPrompt: false,
                        closeSession: true,
                        deleteSession: false,
                        embeddedContextPrompt: false,
                        imagePrompt: false,
                        listSessions: false,
                        loadSession: true,
                        promptQueueing: false,
                        renameSession: false,
                        resumeSession: true,
                        steering: false,
                        unstableForkSession: true,
                    },
                    commands: [],
                    configOptions: [],
                    configurationRevision: "revision-1",
                    directory: ".",
                    directoryLabel: "Workspace",
                    restored: false,
                },
            },
            encryption.sender,
            signal,
        );
    };
    const wrong = await forkResult("codex", "wrong-destination");
    const expected = await forkResult("claude", "forked-session");
    computer.daemon.send(wrong);
    computer.daemon.send(expected);
    const result = await response;
    expect(result.status).toBe(200);
    const routed: unknown = await result.json();
    expect(routed).toEqual(JSON.parse(expected));
    expect(await nativeSessionResultCodec.decode(JSON.stringify(routed), encryption.receiver, signal)).toMatchObject({
        action: "fork",
        target: { harness: "claude", sessionId: "forked-session" },
    });
});

it("Given a forwarded native Session request, When the browser cancels it, Then the same Computer receives its Worker-owned cancellation", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "cancel-native" };
    const { credential } = await issueSession(computer.computerId, target);
    const opened = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const socket = opened.webSocket;
    if (socket === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(socket);
    socket.accept();
    onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
    const { receiver } = await encryptionPair();
    const command = await nativeSessionCommandCodec.encode(
        { kind: "native.session.request", requestId: "native-cancel-id", action: "active-turn", target },
        receiver,
        new AbortController().signal,
    );
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "cancel-http",
            method: "GET",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/active-turn`,
            headers: [
                ["authorization", `Bearer ${credential}`],
                ["content-type", "application/json"],
            ],
            body: command,
        }),
    );
    expect(await computer.daemonInbox.next()).toEqual(JSON.parse(command));
    socket.send(JSON.stringify({ kind: "http.cancel", requestId: "cancel-http" }));
    expect(await computer.daemonInbox.next()).toEqual({ kind: "worker.request.cancel", requestId: "native-cancel-id" });
    inbox.send('{"kind":"ping"}');
    expect(await inbox.next()).toEqual({ kind: "pong" });
});

it("Given a native request forwarded to an earlier daemon, When the daemon is replaced and the caller cancels, Then the replacement receives no stale cancellation", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "replacement-cancel" };
    const { credential } = await issueSession(computer.computerId, target);
    const transportResponse = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const browser = transportResponse.webSocket;
    if (browser === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(browser);
    browser.accept();
    onTestFinished(() => closeBrowserSocket(browser, new AbortController().signal));
    const initialCrypto = await encryptionPair();
    const nextCrypto = await encryptionPair();
    const signal = new AbortController().signal;
    const headers = [
        ["authorization", `Bearer ${credential}`],
        ["content-type", "application/json"],
    ];
    const initial = await nativeSessionCommandCodec.encode(
        { kind: "native.session.request", requestId: "old-native", action: "active-turn", target },
        initialCrypto.receiver,
        signal,
    );
    browser.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "old-http",
            method: "GET",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/active-turn`,
            headers,
            body: initial,
        }),
    );
    expect(await computer.daemonInbox.next()).toEqual(JSON.parse(initial));
    const successor = computer.successorCredential;
    const replacement = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/connect`, {
            headers: {
                Upgrade: "websocket",
                authorization: `Bearer ${successor}`,
                [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: computerCredentialSuccessor(successor),
            },
        }),
    );
    const daemon = replacement.webSocket;
    if (daemon === null) {
        throw new Error("Expected the replacement daemon");
    }
    const daemonInbox = new Inbox(daemon);
    daemon.accept();
    onTestFinished(() => daemon.close(1000, "Test complete"));
    expect(await daemonInbox.next()).toEqual({ kind: "computer.liveness.ready" });
    browser.send(JSON.stringify({ kind: "http.cancel", requestId: "old-http" }));
    inbox.send('{"kind":"ping"}');
    expect(await inbox.next()).toEqual({ kind: "pong" });
    const next = await sessionConfigReadCommandCodec.encode(
        { kind: "session.config.read", requestId: "new-request", target },
        nextCrypto.receiver,
        signal,
    );
    browser.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "new-http",
            method: "GET",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/configuration`,
            headers,
            body: next,
        }),
    );
    expect(await daemonInbox.next()).toEqual(JSON.parse(next));
    const reply = await sessionOperationFailedEventCodec.encode(
        {
            kind: "session.operation.failed",
            requestId: "new-request",
            target,
            code: "agent_execution_failed",
            message: "Request ended",
        },
        nextCrypto.sender,
        signal,
    );
    daemon.send(reply);
    expect(await inbox.next()).toMatchObject({ kind: "http.response", requestId: "new-http", status: 200 });
});

it("Given a forwarded prompt, When the browser cancels its HTTP request, Then the prompt is not cancelled as native Session work", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "cancel-prompt" };
    const { credential } = await issueSession(computer.computerId, target);
    const opened = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const socket = opened.webSocket;
    if (socket === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(socket);
    socket.accept();
    onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
    const promptEncryption = await encryptionPair();
    const nativeEncryption = await encryptionPair();
    const signal = new AbortController().signal;
    const prompt = await sessionPromptCommandCodec.encode(
        {
            kind: "session.prompt",
            commandId: "prompt-not-native",
            requestId: "prompt-native-request",
            target,
            prompt: "Keep running",
            attachments: [],
            disposition: "append",
        },
        promptEncryption.receiver,
        signal,
    );
    const headers = [
        ["authorization", `Bearer ${credential}`],
        ["content-type", "application/json"],
    ];
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "prompt-http",
            method: "POST",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/turns`,
            headers,
            body: prompt,
        }),
    );
    expect(await computer.daemonInbox.next()).toEqual(JSON.parse(prompt));
    socket.send(JSON.stringify({ kind: "http.cancel", requestId: "prompt-http" }));
    socket.send('{"kind":"ping"}');
    expect(await inbox.next()).toEqual({ kind: "pong" });
    const native = await nativeSessionCommandCodec.encode(
        { kind: "native.session.request", requestId: "next-native", action: "active-turn", target },
        nativeEncryption.receiver,
        signal,
    );
    socket.send(
        JSON.stringify({
            kind: "http.request",
            requestId: "next-http",
            method: "GET",
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/active-turn`,
            headers,
            body: native,
        }),
    );
    expect(await computer.daemonInbox.next()).toEqual(JSON.parse(native));
    const reply = await sessionOperationFailedEventCodec.encode(
        {
            kind: "session.operation.failed",
            requestId: "next-native",
            target,
            code: "agent_execution_failed",
            message: "Native request ended",
        },
        nativeEncryption.sender,
        signal,
    );
    computer.daemon.send(reply);
    expect(await inbox.next()).toMatchObject({ kind: "http.response", requestId: "next-http", status: 200 });
});

async function connectedComputer() {
    const owner = await createOwner();
    const { computerId } = owner;
    const credential = await pairComputer(computerId);
    const successorCredential = computerCredentialSuccessor(credential);
    const connected = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/connect`, {
            headers: {
                Upgrade: "websocket",
                authorization: `Bearer ${credential}`,
                [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: successorCredential,
            },
        }),
    );
    expect(connected.status).toBe(101);
    const daemon = connected.webSocket;
    if (daemon === null) {
        throw new Error("Expected the paired daemon connection");
    }
    const daemonInbox = new Inbox(daemon);
    daemon.accept();
    onTestFinished(() => daemon.close(1000, "Test complete"));
    expect(await daemonInbox.next()).toEqual({ kind: "computer.liveness.ready" });
    let subscriptionCount = 0;
    return {
        daemon,
        daemonInbox,
        computerId,
        ownerToken: owner.token,
        credential,
        successorCredential,
        subscribe: async (target: NativeSessionTarget, expiresInSeconds = 900) => {
            const { credential } = await issueSession(computerId, target, expiresInSeconds);
            const response = await ownerRequest(
                new Request(`${ownerOrigin}/morty/api/v1/computers/${computerId}/transport`, {
                    headers: { Upgrade: "websocket" },
                }),
            );
            expect(response.status).toBe(101);
            const socket = response.webSocket;
            if (socket === null) {
                throw new Error("Expected the browser transport");
            }
            const inbox = new Inbox(socket);
            socket.accept();
            onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
            subscriptionCount += 1;
            const subscriptionId = subscriptionCount === 1 ? "events" : `events-${subscriptionCount}`;
            const { sender } = await encryptionPair();
            const encoded = await sessionEventsSubscribeCommandCodec.encode(
                { kind: "session.events.subscribe", subscriptionId, target },
                sender,
                new AbortController().signal,
            );
            socket.send(
                JSON.stringify({
                    kind: "session.events.subscribe",
                    subscriptionId,
                    body: encoded,
                    path: `/morty/api/v1/computers/${computerId}/harnesses/${target.harness}/sessions/${target.sessionId}/events`,
                    headers: [
                        ["authorization", `Bearer ${credential}`],
                        ["content-type", "application/json"],
                    ],
                }),
            );
            expect(await inbox.next()).toMatchObject({ kind: "session.events.ready" });
            expect(await daemonInbox.next()).toEqual(JSON.parse(encoded));
            return inbox;
        },
    };
}

it("Given a Session credential, When a subscription names a different Session, Then the Worker rejects it without registering it on the Computer", async () => {
    const computer = await connectedComputer();
    const allowed = { harness: "claude", sessionId: "allowed" };
    const other = { harness: "claude", sessionId: "other" };
    const { credential } = await issueSession(computer.computerId, allowed);
    const response = await ownerRequest(
        new Request(`${ownerOrigin}/morty/api/v1/computers/${computer.computerId}/transport`, {
            headers: { Upgrade: "websocket" },
        }),
    );
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected the browser transport");
    }
    const inbox = new Inbox(socket);
    socket.accept();
    onTestFinished(() => closeBrowserSocket(socket, new AbortController().signal));
    const { sender } = await encryptionPair();
    const encoded = await sessionEventsSubscribeCommandCodec.encode(
        { kind: "session.events.subscribe", subscriptionId: "forged", target: other },
        sender,
        new AbortController().signal,
    );
    socket.send(
        JSON.stringify({
            kind: "session.events.subscribe",
            subscriptionId: "forged",
            body: encoded,
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${allowed.harness}/sessions/${allowed.sessionId}/events`,
            headers: [
                ["authorization", `Bearer ${credential}`],
                ["content-type", "application/json"],
            ],
        }),
    );
    expect(await inbox.next()).toMatchObject({
        kind: "session.events.error",
        code: "invalid_request",
        subscriptionId: "forged",
    });
    const wrongId = await sessionEventsSubscribeCommandCodec.encode(
        { kind: "session.events.subscribe", subscriptionId: "inner-id", target: allowed },
        sender,
        new AbortController().signal,
    );
    socket.send(
        JSON.stringify({
            kind: "session.events.subscribe",
            subscriptionId: "outer-id",
            body: wrongId,
            path: `/morty/api/v1/computers/${computer.computerId}/harnesses/${allowed.harness}/sessions/${allowed.sessionId}/events`,
            headers: [
                ["authorization", `Bearer ${credential}`],
                ["content-type", "application/json"],
            ],
        }),
    );
    expect(await inbox.next()).toMatchObject({ kind: "http.error", code: "invalid_message" });
    await computer.subscribe(allowed);
});

const event = (target: NativeSessionTarget, id: string) => ({
    eventId: id,
    position: "1",
    recordedAt: "2030-01-01T00:00:00Z",
    sessionGenerationId: "generation-1",
    target,
    type: "acp",
    futureField: { preserved: true },
    payload: { sessionUpdate: "future_update", content: { type: "future_content", text: id } },
});

async function encryptionPair() {
    const computer = await generateE2EIdentity();
    const signal = new AbortController().signal;
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const access = {
        computerId: "computer-1",
        computerE2EPublicKey: await exportE2EPublicKey(computer.publicKey),
        computerE2EAccessSecret: btoa(String.fromCharCode(...secret))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", ""),
    };
    const claims = new Set<string>();
    const sender = await createComputerPayloadEncryption(
        access,
        async (claim) => {
            if (claims.has(claim.fingerprint)) {
                throw new Error("Replay");
            }
            claims.add(claim.fingerprint);
        },
        signal,
    );
    const receiver = await createClientPayloadEncryption(access, signal);
    onTestFinished(() => {
        sender.close();
        receiver.close();
    });
    return { sender, receiver };
}

it("Given two authorized Session viewers, When the Computer sends encrypted single-target events, Then only the matching viewer receives the original frames in order", async () => {
    const computer = await connectedComputer();
    const first = { harness: "claude", sessionId: "encrypted-first" };
    const second = { harness: "codex", sessionId: "encrypted-second" };
    const firstInbox = await computer.subscribe(first);
    const secondInbox = await computer.subscribe(second);
    const { sender: encryptor } = await encryptionPair();
    const signal = new AbortController().signal;
    const encode = (target: NativeSessionTarget, id: string): Promise<string> => {
        const message = decodeSessionEventEnvelope({
            kind: "session.event.v2",
            events: [
                {
                    eventId: id,
                    sessionGenerationId: "generation-1",
                    target,
                    recordedAt: "2030-01-01T00:00:00Z",
                    position: "1",
                    type: "acp",
                    payload: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: id,
                        content: { type: "text", text: `secret-${id}` },
                    },
                },
            ],
        });
        return sessionEventEnvelopeCodec.encode(message, encryptor, signal);
    };
    const firstWire = await encode(first, "first");
    const nextWire = await encode(first, "next");
    const secondWire = await encode(second, "other");
    computer.daemon.send(firstWire);
    computer.daemon.send(nextWire);
    computer.daemon.send(secondWire);
    expect(JSON.parse(firstWire)).toMatchObject({ kind: "session.event.v2", target: first });
    expect(firstWire).not.toContain("secret-first");
    const frame = v.object({ kind: v.literal("session.events.event"), data: v.string() });
    expect(v.parse(frame, await firstInbox.next()).data).toBe(firstWire);
    expect(v.parse(frame, await firstInbox.next()).data).toBe(nextWire);
    expect(v.parse(frame, await secondInbox.next()).data).toBe(secondWire);
});

it("Given an expired Session viewer, When the Computer sends an encrypted event, Then the subscription ends without delivering it", async () => {
    const computer = await connectedComputer();
    const target = { harness: "claude", sessionId: "expired-session" };
    const inbox = await computer.subscribe(target, 60);
    const { sender: encryptor } = await encryptionPair();
    const message = decodeSessionEventEnvelope({
        kind: "session.event.v2",
        events: [
            {
                eventId: "expired-event",
                sessionGenerationId: "generation-1",
                target,
                recordedAt: "2030-01-01T00:00:00Z",
                position: "1",
                type: "acp",
                payload: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "expired-event",
                    content: { type: "text", text: "private expired event" },
                },
            },
        ],
    });
    const wire = await sessionEventEnvelopeCodec.encode(message, encryptor, new AbortController().signal);
    vi.setSystemTime(new Date("2030-01-01T00:01:01Z"));
    computer.daemon.send(wire);
    expect(await inbox.next()).toMatchObject({ kind: "session.events.end", subscriptionId: "events" });
    expect(await computer.daemonInbox.next()).toEqual({
        kind: "session.events.unsubscribe",
        subscriptionId: "events",
        target,
    });
});

it("Given viewers of two native Session pairs, When the Computer sends separate encrypted events with future content, Then each viewer receives only its original frame", async () => {
    const computer = await connectedComputer();
    const first = { harness: "claude", sessionId: "shared-id" };
    const second = { harness: "codex", sessionId: "shared-id" };
    const firstInbox = await computer.subscribe(first);
    const secondInbox = await computer.subscribe(second);
    const firstEvent = event(first, "first-event");
    const secondEvent = event(second, "second-event");
    const firstCrypto = await encryptionPair();
    const secondCrypto = await encryptionPair();
    const signal = new AbortController().signal;
    const encoder = new TextEncoder();
    const encodeFuture = async (target: NativeSessionTarget, value: unknown, sender: PayloadEncryptionConnection) => {
        const routing = { kind: "session.event.v2", target };
        const encrypted = await sender.encrypt(
            encoder.encode(JSON.stringify({ events: [value] })),
            encoder.encode(JSON.stringify(routing)),
            signal,
        );
        return JSON.stringify({ ...routing, encrypted });
    };
    const firstWire = await encodeFuture(first, firstEvent, firstCrypto.sender);
    const secondWire = await encodeFuture(second, secondEvent, secondCrypto.sender);
    computer.daemon.send(firstWire);
    computer.daemon.send(secondWire);
    for (const [inbox, expected, wire, target, receiver] of [
        [firstInbox, firstEvent, firstWire, first, firstCrypto.receiver],
        [secondInbox, secondEvent, secondWire, second, secondCrypto.receiver],
    ] as const) {
        const received = v.parse(
            v.object({ kind: v.literal("session.events.event"), data: v.string() }),
            await inbox.next(),
        );
        expect(received.data).toBe(wire);
        const parsed = v.parse(v.object({ encrypted: v.string() }), JSON.parse(received.data));
        const plaintext = await receiver.decrypt(
            parsed.encrypted,
            encoder.encode(JSON.stringify({ kind: "session.event.v2", target })),
            signal,
        );
        expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({ events: [expected] });
    }
});

it("Given two live Session views, When the Computer sends an encrypted close notice, Then only its viewer receives the original notice and the other continues receiving output", async () => {
    const computer = await connectedComputer();
    const closed = { harness: "claude", sessionId: "closed-session" };
    const open = { harness: "claude", sessionId: "open-session" };
    const closedInbox = await computer.subscribe(closed);
    const openInbox = await computer.subscribe(open);
    const closedCrypto = await encryptionPair();
    const openCrypto = await encryptionPair();
    const signal = new AbortController().signal;
    const notice = { kind: "session.close.notice", target: closed, reason: "Session released" };
    const wire = await sessionCloseNoticeEventCodec.encode(notice, closedCrypto.sender, signal);
    const output = decodeSessionEventEnvelope({
        kind: "session.event.v2",
        events: [
            {
                eventId: "still-open",
                position: "1",
                recordedAt: "2030-01-01T00:00:00Z",
                sessionGenerationId: "generation-1",
                target: open,
                type: "acp",
                payload: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "still-open",
                    content: { type: "text", text: "still-open" },
                },
            },
        ],
    });
    const outputWire = await sessionEventEnvelopeCodec.encode(output, openCrypto.sender, signal);
    computer.daemon.send(wire);
    computer.daemon.send(outputWire);
    const frame = v.object({ kind: v.literal("session.events.event"), data: v.string() });
    const receivedNotice = v.parse(frame, await closedInbox.next()).data;
    expect(receivedNotice).toBe(wire);
    expect(await sessionCloseNoticeEventCodec.decode(receivedNotice, closedCrypto.receiver, signal)).toEqual(notice);
    const receivedOutput = v.parse(frame, await openInbox.next()).data;
    expect(receivedOutput).toBe(outputWire);
    expect(await sessionEventEnvelopeCodec.decode(receivedOutput, openCrypto.receiver, signal)).toEqual(output);
});
