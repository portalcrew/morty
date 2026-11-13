import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
    type ComputerEncryptionAccess,
    createClientPayloadEncryption,
    createComputerPayloadEncryption,
    exportE2EPublicKey,
    generateE2EIdentity,
    MortyClient,
    MortyPageRequest,
    WsTransport,
} from "@morty-build/client";
import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    CONTENT_CHUNK_MAX_BYTES,
    computerCredentialSuccessor,
    contentAvailableEventCodec,
    contentChunkCodec,
    contentCommitCommandCodec,
    contentReadyEventCodec,
    contentWriteCommandCodec,
    decodeEncryptedDaemonInboundMessage,
    decodeEncryptedDaemonMessage,
    decodeFileReadCommand,
    decodeSessionAccessCredential,
    decodeWorkerToDaemonMessage,
    encodeContentChunkFrame,
    encodeEncryptedDaemonInboundMessage,
    encodeEncryptedDaemonMessage,
    encodeFileStreamRecord,
    encodeSessionEventEnvelope,
    encodeSessionPromptAcceptedEvent,
    FILE_STREAM_CONTENT_TYPE,
    fileBeginEventCodec,
    MORTY_API_PREFIX,
    type NativeSessionTarget,
    nativeSessionRequestCodec,
    nativeSessionResultCodec,
    type SessionConfigReadResult,
    sessionCancelBeforeStartCommandCodec,
    sessionCancelCommandCodec,
    sessionConfigReadCommandCodec,
    sessionConfigReadResultCodec,
    sessionElicitationRespondCommandCodec,
    sessionEventEnvelopeCodec,
    sessionEventsSubscribeCommandCodec,
    sessionHistoryPageLoadCodec,
    sessionHistoryPageLoadedCodec,
    sessionOperationFailedEventCodec,
    sessionPermissionRespondCommandCodec,
    sessionPromptAcceptedEventCodec,
    sessionPromptCommandCodec,
    sessionPromptDispositionCommandCodec,
    sessionRenameCommandCodec,
    sessionRenamedEventCodec,
    sessionTurnStoppedEventCodec,
} from "@morty-build/client/protocol";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestMortyRelayApp } from "../../../relay-test-support/src/app.ts";
import { DaemonWebSocketRoutes } from "../../src/computer-relay/components/runtime/daemon-websocket-routes.ts";
import { createRuntimeContext } from "../../src/computer-relay/components/runtime/runtime-context.ts";
import { createRelayDurableObjectContext } from "../../src/computer-relay/composition/relay-durable-object-context.ts";
import { ComputerRelay as RelayComputerRelay } from "../../src/computer-relay/computer-relay.ts";
import { DurableObjectDatabase } from "../../src/computer-relay/infra/durable-object-database.ts";
import { computerObjectName } from "../../src/contracts/computer-id.ts";
import { RelayAuthenticationConfiguration } from "../../src/contracts/relay/computer-management.ts";
import type { RelayBindings } from "../../src/contracts/relay-bindings.ts";
import { browserOperationHeaders, closeBrowserSocket, requestBrowserOperation } from "./browser-session.ts";
import { computerBackend, createOwner, issueSession, ownerRequest } from "./owner-fixture.ts";
import { computerAccess, revokeTestComputer } from "./registered-computer.ts";

const nativeTarget = (sessionId: string): NativeSessionTarget => ({ harness: "codex", sessionId });

async function endpointEncryption(computerId: string, signal: AbortSignal) {
    const identity = await generateE2EIdentity();
    const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    const access = {
        computerId,
        computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
        computerE2EAccessSecret: secret,
    };
    const seen = new Set<string>();
    const computer = await createComputerPayloadEncryption(
        access,
        async (claim, claimSignal) => {
            claimSignal.throwIfAborted();
            if (seen.has(claim.fingerprint)) {
                throw new Error("Duplicate encrypted request");
            }
            seen.add(claim.fingerprint);
        },
        signal,
    );
    const client = await createClientPayloadEncryption(access, signal);
    onTestFinished(() => {
        computer.close();
        client.close();
    });
    return { access, computer, client };
}

function sessionEndpointClient(computerId: string, credential: string, access: ComputerEncryptionAccess) {
    const transport = new WsTransport({
        connector: {
            connect: async (endpoint, connectionSignal) => {
                const requestUrl = new URL(endpoint);
                requestUrl.protocol = requestUrl.protocol === "wss:" ? "https:" : "http:";
                const response = await ownerRequest(
                    new Request(requestUrl, { headers: { Upgrade: "websocket" }, signal: connectionSignal }),
                );
                if (response.status !== 101 || response.webSocket === null) {
                    throw new Error("Expected a browser transport");
                }
                response.webSocket.accept();
                return response.webSocket;
            },
        },
    });
    const client = new MortyClient({
        transport,
        endpoint: relayOrigin,
        computerId,
        encryption: { access },
        credentialProvider: { credential: async () => credential },
    });
    onTestFinished(() => client.close());
    return client;
}

function liveEvent(sessionTarget: NativeSessionTarget, text: string): string {
    return encodeSessionEventEnvelope({
        kind: "session.event.v2",
        events: [
            {
                eventId: "event-1",
                position: "1",
                recordedAt: "2026-09-18T00:00:00.000Z",
                sessionGenerationId: "session-generation-1",
                target: sessionTarget,
                type: "acp",
                payload: {
                    messageId: "message-1",
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text },
                },
            },
        ],
    });
}

const relayOrigin = "https://relay.test";
const readyAgents = [
    {
        agentPath: "/usr/local/bin/codex",
        agentVersion: "codex 1.0.0",
        capabilities: {
            audioPrompt: false,
            closeSession: true,
            deleteSession: true,
            embeddedContextPrompt: true,
            imagePrompt: true,
            listSessions: true,
            loadSession: true,
            promptQueueing: false,
            renameSession: false,
            resumeSession: true,
            steering: false,
            unstableForkSession: false,
        },
        harness: "codex",
        label: "Codex",
    },
];

/** Connects as a paired daemon does: each connection presents the credential and a successor that becomes current. */
class DaemonCredential {
    #current: string;

    constructor(credential: string) {
        this.#current = credential;
    }

    readonly connect = async (fetch: (request: Request) => Response | Promise<Response>): Promise<Response> => {
        const successor = computerCredentialSuccessor(this.#current);
        const response = await fetch(
            new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/connect`, {
                headers: {
                    authorization: `Bearer ${this.#current}`,
                    [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]: successor,
                    Upgrade: "websocket",
                },
            }),
        );
        if (response.status === 101) {
            this.#current = successor;
        }
        return response;
    };
}

function bindings(): RelayBindings {
    return {
        COMPUTER_RELAY: env.COMPUTER_RELAY,
        MORTY_SESSION_SIGNING_SECRET: env.MORTY_SESSION_SIGNING_SECRET,
    };
}

type CredentialSigner = () => Promise<CryptoKey>;
async function relaySigningKey(signingSecret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(signingSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
}
const relaySigner: CredentialSigner = () => relaySigningKey(env.MORTY_SESSION_SIGNING_SECRET);
const storedDigestSigner: CredentialSigner = () => relaySigningKey("unrelated-credential-digest");

function credentialHeaders(credential: string): Headers {
    return new Headers({ authorization: `Bearer ${credential}`, "content-type": "application/json" });
}

class SocketMessages {
    readonly #messages: unknown[] = [];
    readonly #resolvers: Array<(message: unknown) => void> = [];

    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            const resolve = this.#resolvers.shift();
            if (resolve === undefined) {
                this.#messages.push(event.data);
            } else {
                resolve(event.data);
            }
        });
    }

    readonly nextFrame = (): Promise<unknown> => {
        const message = this.#messages.shift();
        return message === undefined
            ? new Promise((resolve) => this.#resolvers.push(resolve))
            : Promise.resolve(message);
    };

    readonly next = async (): Promise<string> => {
        const message = await this.nextFrame();
        if (typeof message !== "string") {
            throw new Error("Expected a text WebSocket message");
        }
        return message;
    };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a response object");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function text(value: Readonly<Record<string, unknown>>, name: string): string {
    const field = value[name];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`Expected ${name}`);
    }
    return field;
}

async function responseJson(response: Response, expectedStatus: number): Promise<Readonly<Record<string, unknown>>> {
    const body = await response.json();
    expect(response.status).toBe(expectedStatus);
    return record(body);
}

async function openBrowserSubscription(
    fetch: (request: Request) => Response | Promise<Response>,
    request: Request,
    registerCleanup: (cleanup: () => Promise<void>) => void = onTestFinished,
) {
    const path = new URL(request.url);
    const computerId = path.pathname.slice(`${MORTY_API_PREFIX}/v1/computers/`.length).split("/")[0];
    const match = /\/harnesses\/([^/]+)\/sessions\/([^/]+)\/events$/u.exec(path.pathname);
    if (computerId === undefined || match === null || match[1] === undefined || match[2] === undefined) {
        throw new Error("Expected a Session subscription path");
    }
    const target = { harness: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]) };
    const subscriptionId = crypto.randomUUID();
    const encryption = await endpointEncryption(computerId, request.signal);
    const encoded = await sessionEventsSubscribeCommandCodec.encode(
        { kind: "session.events.subscribe", subscriptionId, target },
        encryption.client,
        request.signal,
    );
    const opened = await fetch(
        new Request(new URL(`${MORTY_API_PREFIX}/v1/computers/${computerId}/transport`, path), {
            headers: { upgrade: "websocket" },
            signal: request.signal,
        }),
    );
    const socket = opened.webSocket;
    if (opened.status !== 101 || socket === null) {
        throw new Error(`Expected a browser transport, received ${opened.status}`);
    }
    const messages = new SocketMessages(socket);
    socket.accept();
    registerCleanup(() => closeBrowserSocket(socket, new AbortController().signal));
    socket.send(
        JSON.stringify({
            kind: "session.events.subscribe",
            subscriptionId,
            path: `${path.pathname}${path.search}`,
            headers: [...browserOperationHeaders(request), ["content-type", "application/json"]],
            body: encoded,
        }),
    );
    return { socket, messages, encryption, admission: record(JSON.parse(await messages.next())) };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

afterAll(async () => {
    await abortAllDurableObjects();
});

describe.sequential("Relay Session-only boundary", () => {
    it("Given an allowed Chat origin, When the browser preflights a Session file read, Then Relay permits Session authorization with the Session credential headers", async () => {
        const browserOrigin = "https://chat.test";
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration(new Set([browserOrigin])));
        const computerId = "prj_ap_01_abcdefghijklmnopqrstuvwx";

        const response = await worker.fetch(
            new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/local-session/files/content?maxBytes=33554432&path=%2Fworkspace%2Fpackage.json`,
                {
                    headers: {
                        "access-control-request-headers": "authorization",
                        "access-control-request-method": "GET",
                        origin: browserOrigin,
                    },
                    method: "OPTIONS",
                },
            ),
            bindings(),
        );

        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(browserOrigin);
        expect(response.headers.get("access-control-allow-methods")).toContain("GET");
        expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    });

    it("Given a linked Computer, When browser subscriptions and history cross Relay hibernation, Then events stay lossless and replies stay correlated without cloud Session storage", async () => {
        vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration());
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const backend = computerBackend(computerId);
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "private-reconnect-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const redemptionUrl = `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${text(pairing, "computerId")}/pairing/redeem`;
        const claimed = await responseJson(
            await worker.fetch(
                new Request(redemptionUrl, {
                    body: JSON.stringify({
                        agents: readyAgents,
                        computerName: "Private reconnect Computer",
                        pairingCode: text(pairing, "pairingCode"),
                        workspaceName: "private-reconnect-workspace",
                    }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
                environment,
            ),
            200,
        );
        expect(claimed).not.toHaveProperty("appId");
        expect(await backend.agents(AbortSignal.timeout(10000))).toMatchObject({
            agents: [{ harness: "codex", label: "Codex" }],
            computerId,
        });
        const sessionId = "local-codex-session";
        const daemonCredential = new DaemonCredential(text(claimed, "computerCredential"));
        const daemonResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
        expect(daemonResponse.status).toBe(101);
        if (daemonResponse.webSocket === null) {
            throw new Error("Expected a daemon socket");
        }
        const daemon = daemonResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        daemon.accept();
        try {
            expect(decodeWorkerToDaemonMessage(await daemonMessages.next()).kind).toBe("computer.liveness.ready");
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(computerId, signal);
            const answer = await sessionEventEnvelopeCodec.encode(
                JSON.parse(liveEvent(nativeTarget(sessionId), "local answer")),
                encryption.computer,
                signal,
            );

            const browserAccess = await issueSession(computerId, nativeTarget(sessionId));
            const v2Response = await worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/transport`, {
                    headers: {
                        authorization: `Bearer ${text(browserAccess, "credential")}`,
                        Upgrade: "websocket",
                    },
                }),
                environment,
            );
            expect(v2Response.status).toBe(101);
            if (v2Response.webSocket === null) {
                throw new Error("Expected the V2 Session event socket");
            }
            const v2Socket = v2Response.webSocket;
            const v2Messages = new SocketMessages(v2Socket);
            v2Socket.accept();
            const subscription = await sessionEventsSubscribeCommandCodec.encode(
                { kind: "session.events.subscribe", subscriptionId: "raw-events", target: nativeTarget(sessionId) },
                encryption.client,
                signal,
            );
            v2Socket.send(
                JSON.stringify({
                    kind: "session.events.subscribe",
                    subscriptionId: "raw-events",
                    body: subscription,
                    path: `${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events`,
                    headers: [
                        ["authorization", `Bearer ${text(browserAccess, "credential")}`],
                        ["content-type", "application/json"],
                    ],
                }),
            );
            expect(JSON.parse(await v2Messages.next())).toMatchObject({ kind: "session.events.ready" });
            expect(
                await decodeEncryptedDaemonInboundMessage(await daemonMessages.next(), encryption.computer, signal),
            ).toMatchObject({
                kind: "session.events.subscribe",
                subscriptionId: "raw-events",
                target: nativeTarget(sessionId),
            });
            const rawEvent = {
                eventId: "event-v2-1",
                payload: {
                    content: { text: "raw local answer", type: "text" as const },
                    messageId: "message-v2-1",
                    sessionUpdate: "agent_message_chunk" as const,
                },
                position: "1",
                recordedAt: "2026-09-18T00:00:00.000Z",
                sessionGenerationId: "session-generation-1",
                target: nativeTarget(sessionId),
                type: "acp" as const,
            };
            const historicalEvent = {
                eventId: rawEvent.eventId,
                payload: rawEvent.payload,
                recordedAt: rawEvent.recordedAt,
                sessionGenerationId: rawEvent.sessionGenerationId,
                target: rawEvent.target,
                type: rawEvent.type,
            };
            const secondRawEvent = { ...rawEvent, eventId: "event-v2-2", position: "2" };
            const eventWire = await sessionEventEnvelopeCodec.encode(
                { events: [rawEvent, secondRawEvent], kind: "session.event.v2" },
                encryption.computer,
                signal,
            );
            daemon.send(eventWire);
            const forwarded = text(record(JSON.parse(await v2Messages.next())), "data");
            expect(forwarded).toBe(eventWire);
            expect((await sessionEventEnvelopeCodec.decode(forwarded, encryption.client, signal)).events).toEqual([
                rawEvent,
                secondRawEvent,
            ]);
            const futureEvent = {
                ...rawEvent,
                eventId: "event-v2-future",
                position: "3",
                futureField: "retained",
                payload: {
                    ...rawEvent.payload,
                    content: { type: "future_content", text: "Future public output", extra: { retained: true } },
                },
            };
            const routing = { kind: "session.event.v2", target: nativeTarget(sessionId) };
            const authenticated = new TextEncoder().encode(JSON.stringify(routing));
            const opaque = await encryption.computer.encrypt(
                new TextEncoder().encode(JSON.stringify({ events: [futureEvent] })),
                authenticated,
                signal,
            );
            const futureWire = JSON.stringify({ ...routing, encrypted: opaque });
            daemon.send(futureWire);
            const forwardedFuture = text(record(JSON.parse(await v2Messages.next())), "data");
            expect(forwardedFuture).toBe(futureWire);
            expect(
                JSON.parse(new TextDecoder().decode(await encryption.client.decrypt(opaque, authenticated, signal))),
            ).toEqual({ events: [futureEvent] });
            const historyRequest = await sessionHistoryPageLoadCodec.encode(
                {
                    kind: "session.live-history.v2.page.load",
                    requestId: "history-first",
                    target: nativeTarget(sessionId),
                    cursor: null,
                    eventLimit: 50,
                },
                encryption.client,
                signal,
            );
            const historyResponse = requestBrowserOperation(
                (request) => worker.fetch(request, environment),
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events?limit=50`,
                    { headers: credentialHeaders(text(browserAccess, "credential")), signal },
                ),
                historyRequest,
            );
            const historyLoad = await decodeEncryptedDaemonInboundMessage(
                await daemonMessages.next(),
                encryption.computer,
                signal,
            );
            if (historyLoad.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected history loading without a preceding Session query");
            }

            const historyPayload = {
                events: {
                    events: {
                        sessionGenerationId: "session-generation-1",
                        events: [futureEvent, historicalEvent],
                        nextCursor: null,
                        tailCursor: rawEvent.eventId,
                        throughPosition: "1",
                        truncated: false,
                        version: 2,
                    },
                    queuedPromptRequests: [],
                },
            };
            const historyAddress = {
                kind: "session.live-history.v2.page.loaded",
                requestId: historyLoad.requestId,
                target: nativeTarget(sessionId),
            };
            const historyAad = new TextEncoder().encode(JSON.stringify(historyAddress));
            const encryptedHistory = await encryption.computer.encrypt(
                new TextEncoder().encode(JSON.stringify(historyPayload)),
                historyAad,
                signal,
            );
            const historyPage = JSON.stringify({ ...historyAddress, encrypted: encryptedHistory });
            daemon.send(historyPage);
            const historyRouting = await responseJson(await historyResponse, 200);
            expect(
                JSON.parse(
                    new TextDecoder().decode(
                        await encryption.client.decrypt(text(historyRouting, "encrypted"), historyAad, signal),
                    ),
                ),
            ).toEqual({
                events: {
                    events: {
                        sessionGenerationId: "session-generation-1",
                        events: [futureEvent, historicalEvent],
                        nextCursor: null,
                        tailCursor: rawEvent.eventId,
                        throughPosition: "1",
                        truncated: false,
                        version: 2,
                    },
                    queuedPromptRequests: [],
                },
            });
            // Browser transports are not hibernatable. Finish the subscription before waking the daemon again.
            await closeBrowserSocket(v2Socket, new AbortController().signal);
            expect(decodeWorkerToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "session.events.unsubscribe",
                subscriptionId: "raw-events",
                target: nativeTarget(sessionId),
            });
            await evictDurableObject(environment.COMPUTER_RELAY.getByName(computerObjectName(computerId)), {
                webSockets: "hibernate",
            });
            // A delayed result after the caller has finished must not disconnect the Computer.
            daemon.send(historyPage);
            // A Computer that closed the Session refuses to load its history. The refusal is a typed conflict, so a
            // client can offer to reopen the Session instead of retrying the load.
            const client = sessionEndpointClient(computerId, text(browserAccess, "credential"), encryption.access);
            const closedHistoryResponse = client.events
                .list(nativeTarget(sessionId), new MortyPageRequest(50, ""), signal)
                .then(
                    (value) => ({ kind: "success", value }),
                    (error: unknown) => ({ kind: "failure", error }),
                );
            const closedHistoryLoad = await decodeEncryptedDaemonInboundMessage(
                await daemonMessages.next(),
                encryption.computer,
                signal,
            );
            if (closedHistoryLoad.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected a live Session history request");
            }
            daemon.send(
                await sessionOperationFailedEventCodec.encode(
                    {
                        code: "session_closed",
                        kind: "session.operation.failed",
                        message: "The Session is closed",
                        requestId: closedHistoryLoad.requestId,
                        target: nativeTarget(sessionId),
                    },
                    encryption.computer,
                    signal,
                ),
            );
            expect(await closedHistoryResponse).toMatchObject({
                kind: "failure",
                error: { code: "session_closed", message: "The Session is closed" },
            });
            v2Socket.close(1000, "V2 browser test complete");
            const transportResponse = await worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/transport`, {
                    headers: { Upgrade: "websocket" },
                }),
                environment,
            );
            expect(transportResponse.status).toBe(101);
            if (transportResponse.webSocket === null) {
                throw new Error("Expected the browser transport socket");
            }
            const transport = transportResponse.webSocket;
            const transportMessages = new SocketMessages(transport);
            transport.accept();
            const firstSubscribe = await sessionEventsSubscribeCommandCodec.encode(
                { kind: "session.events.subscribe", subscriptionId: "subscription-1", target: nativeTarget(sessionId) },
                encryption.client,
                signal,
            );
            transport.send(
                JSON.stringify({
                    headers: [
                        ["authorization", `Bearer ${text(browserAccess, "credential")}`],
                        ["content-type", "application/json"],
                    ],
                    kind: "session.events.subscribe",
                    body: firstSubscribe,
                    path: `${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events`,
                    subscriptionId: "subscription-1",
                }),
            );
            expect(JSON.parse(await transportMessages.next())).toMatchObject({
                kind: "session.events.ready",
                subscriptionId: "subscription-1",
            });
            expect(
                await decodeEncryptedDaemonInboundMessage(await daemonMessages.next(), encryption.computer, signal),
            ).toMatchObject({ kind: "session.events.subscribe", subscriptionId: "subscription-1" });
            const otherBrowser = (
                await worker.fetch(
                    new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/transport`, {
                        headers: { Upgrade: "websocket" },
                    }),
                    environment,
                )
            ).webSocket;
            if (otherBrowser === null) {
                throw new Error("Expected a second browser transport");
            }
            const otherMessages = new SocketMessages(otherBrowser);
            otherBrowser.accept();
            const secondClient = await createClientPayloadEncryption(encryption.access, signal);
            onTestFinished(() => secondClient.close());
            const secondSubscribe = await sessionEventsSubscribeCommandCodec.encode(
                { kind: "session.events.subscribe", subscriptionId: "subscription-2", target: nativeTarget(sessionId) },
                secondClient,
                signal,
            );
            otherBrowser.send(
                JSON.stringify({
                    headers: [
                        ["authorization", `Bearer ${text(browserAccess, "credential")}`],
                        ["content-type", "application/json"],
                    ],
                    kind: "session.events.subscribe",
                    body: secondSubscribe,
                    path: `${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events`,
                    subscriptionId: "subscription-2",
                }),
            );
            expect(JSON.parse(await otherMessages.next())).toMatchObject({ kind: "session.events.ready" });
            expect(
                await decodeEncryptedDaemonInboundMessage(await daemonMessages.next(), encryption.computer, signal),
            ).toMatchObject({ kind: "session.events.subscribe", subscriptionId: "subscription-2" });
            transport.send("invalid-json");
            expect(JSON.parse(await transportMessages.next())).toMatchObject({ kind: "http.error" });
            transport.send(
                JSON.stringify({
                    kind: "http.request",
                    requestId: "runtime-agents",
                    method: "GET",
                    path: `${MORTY_API_PREFIX}/v1/computers/${computerId}/daemon/agents`,
                    headers: [["authorization", `Bearer ${appCredential}`]],
                    body: "",
                }),
            );
            expect(JSON.parse(await transportMessages.next())).toMatchObject({
                kind: "http.error",
                requestId: "runtime-agents",
                code: "invalid_target",
                status: 400,
            });
            daemon.send(answer);
            expect(JSON.parse(await transportMessages.next())).toMatchObject({
                data: answer,
                eventId: "",
                kind: "session.events.event",
                seqId: 1,
                subscriptionId: "subscription-1",
            });
            expect(JSON.parse(await otherMessages.next())).toMatchObject({
                kind: "session.events.event",
                subscriptionId: "subscription-2",
                data: answer,
            });
            expect((await sessionEventEnvelopeCodec.decode(answer, encryption.client, signal)).events[0]).toMatchObject(
                { payload: { content: { text: "local answer" } } },
            );
            expect((await sessionEventEnvelopeCodec.decode(answer, secondClient, signal)).events[0]).toMatchObject({
                payload: { content: { text: "local answer" } },
            });
            await closeBrowserSocket(transport, new AbortController().signal);
            expect(decodeWorkerToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "session.events.unsubscribe",
                subscriptionId: "subscription-1",
            });
            otherBrowser.send('{"kind":"ping"}');
            expect(await otherMessages.next()).toBe('{"kind":"pong"}');
            await closeBrowserSocket(otherBrowser, new AbortController().signal);
            expect(decodeWorkerToDaemonMessage(await daemonMessages.next())).toMatchObject({
                kind: "session.events.unsubscribe",
                subscriptionId: "subscription-2",
            });
            await runInDurableObject(
                environment.COMPUTER_RELAY.getByName(computerObjectName(computerId)),
                async (_instance, state) => {
                    const sessionTables = [
                        ...state.storage.sql.exec<{ name: string }>(
                            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'session_bindings', 'session_configuration_snapshots', 'turns', 'attempts', 'interactions', 'pending_work', 'command_receipts', 'session_event_receipts', 'reliable_event_receipts', 'computer_active_sessions', 'computer_disconnect')",
                        ),
                    ];
                    expect(sessionTables).toEqual([]);
                },
            );
        } finally {
            daemon.close(1000, "Test complete");
        }
    }, 180_000);

    it("Given a computer with no discovered local Agent, When it redeems a Computer pairing and publishes its catalog, Then pairing succeeds and the Computer advertises an empty Agent directory", async () => {
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration());
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const backend = computerBackend(computerId);
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "unattended-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${text(pairing, "computerId")}/pairing/redeem`,
                    {
                        body: JSON.stringify({
                            agents: [],
                            futureClientField: "unknown keys are tolerated",
                            computerName: "Unattended Computer",
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: "unattended-workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
                environment,
            ),
            200,
        );
        const computerCredential = text(claimed, "computerCredential");

        expect(await backend.agents(AbortSignal.timeout(10000))).toMatchObject({ agents: [], computerId });

        const catalogUpdate = await worker.fetch(
            new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${text(claimed, "computerId")}/catalog`, {
                body: JSON.stringify({ agents: [], "ignored keys are tolerated": true }),
                headers: { authorization: `Bearer ${computerCredential}`, "content-type": "application/json" },
                method: "PUT",
            }),
            environment,
        );
        expect(catalogUpdate.status).toBe(204);
        expect(await backend.agents(AbortSignal.timeout(10000))).toMatchObject({ agents: [], computerId });
    });
});

/**
 * Pairs a Computer, connects its daemon with liveness, and grants Chat access to one Session.
 *
 * Cloudflare stamps heartbeat answers with its own clock, which fake timers cannot move. With
 * `anchorClockToHeartbeat`, the daemon heartbeats once and the fake clock is set to that answer
 * before the Session credential is issued, so later times are explicit offsets from it.
 */
async function connectComputerDaemon(slug: string, options: { readonly anchorClockToHeartbeat?: boolean } = {}) {
    const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration());
    const environment = bindings();
    const owner = await createOwner();
    const { computerId } = owner;
    const appCredential = owner.token;
    const backend = computerBackend(computerId);
    const pairComputer = async (idempotencyKey: string) => {
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/pairing`, {
                    body: JSON.stringify({ idempotencyKey }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${text(pairing, "computerId")}/pairing/redeem`,
                    {
                        body: JSON.stringify({
                            agents: readyAgents,
                            computerName: `${slug} Computer`,
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: `${slug}-workspace`,
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
                environment,
            ),
            200,
        );
        return new DaemonCredential(text(claimed, "computerCredential"));
    };
    const sessionId = `${slug}-session`;
    const daemonCredential = await pairComputer(`${slug}-runtime`);
    const daemonResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
    if (daemonResponse.webSocket === null) {
        throw new Error("Expected the Computer socket");
    }
    const daemon = daemonResponse.webSocket;
    const daemonMessages = new SocketMessages(daemon);
    const daemonClosed = new Promise<CloseEvent>((resolve) => {
        daemon.addEventListener("close", resolve, { once: true });
    });
    daemon.accept();
    expect(decodeWorkerToDaemonMessage(await daemonMessages.next()).kind).toBe("computer.liveness.ready");
    /** Heartbeats exactly as the daemon does and returns when Cloudflare answered, by its own clock. */
    const heartbeat = async (): Promise<number> => {
        daemon.send(COMPUTER_HEARTBEAT_MESSAGE);
        expect(await daemonMessages.next()).toBe(COMPUTER_HEARTBEAT_ACK_MESSAGE);
        return await runInDurableObject(
            environment.COMPUTER_RELAY.getByName(computerObjectName(computerId)),
            (_instance, state) => {
                const socket = state.getWebSockets("daemon")[0];
                const answeredAt = socket === undefined ? null : state.getWebSocketAutoResponseTimestamp(socket);
                if (answeredAt === null) {
                    throw new Error("Expected Cloudflare to have answered the heartbeat");
                }
                return answeredAt.getTime();
            },
        );
    };
    if (options.anchorClockToHeartbeat === true) {
        vi.setSystemTime(await heartbeat());
    }
    const sessionAccess = await issueSession(computerId, nativeTarget(sessionId));
    const sessionRequest = (request: Request) =>
        requestBrowserOperation((operation) => worker.fetch(operation, environment), request);
    return {
        credential: text(sessionAccess, "credential"),
        transport: () =>
            worker.fetch(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/transport`, {
                    headers: { Upgrade: "websocket" },
                }),
                environment,
            ),
        computerId,
        sessionTarget: nativeTarget(sessionId),
        revoke: async () => {
            await revokeTestComputer(environment, computerId, AbortSignal.timeout(10000));
            return new Response(null, { status: 204 });
        },
        reconnect: () => daemonCredential.connect((request) => worker.fetch(request, environment)),
        pairAgain: pairComputer,
        connect: (credential: DaemonCredential) => credential.connect((request) => worker.fetch(request, environment)),
        subscribe: (credential = text(sessionAccess, "credential")) =>
            openBrowserSubscription(
                (request) => worker.fetch(request, environment),
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/events`,
                    {
                        headers: { authorization: `Bearer ${credential}`, Upgrade: "websocket" },
                    },
                ),
            ),
        forkNative: (operationId: string, encoded: string) =>
            ownerRequest(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/native-sessions/forks/${operationId}`,
                    {
                        method: "POST",
                        headers: credentialHeaders(appCredential),
                        body: encoded,
                    },
                ),
            ),
        appSessionRequest: async (
            path: string,
            init: {
                readonly method: string;
                readonly body?: unknown;
                readonly credential?: string;
                readonly computerId?: string;
            },
        ) =>
            await sessionRequest(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${init.computerId ?? computerId}/harnesses/codex/sessions/${sessionId}${path}`,
                    {
                        method: init.method,
                        headers: credentialHeaders(init.credential ?? sessionAccess.credential),
                        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
                    },
                ),
            ),
        sessionControlRequest: async (path: string, body: unknown, credential = text(sessionAccess, "credential")) =>
            await sessionRequest(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}${path}`,
                    {
                        method: "POST",
                        headers: credentialHeaders(credential),
                        body: JSON.stringify(body),
                    },
                ),
            ),
        uploadContent: async (
            contentKey: string,
            bytes: Uint8Array,
            metadata: {
                readonly kind: "image" | "resource";
                readonly mediaType: string;
                readonly name: string;
                readonly uri: string;
            },
        ) =>
            await sessionRequest(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/content/${contentKey}?${new URLSearchParams({ uri: metadata.uri }).toString()}`,
                    {
                        body: bytes,
                        headers: {
                            authorization: `Bearer ${text(sessionAccess, "credential")}`,
                            "content-type": metadata.mediaType,
                            "x-morty-byte-length": String(bytes.byteLength),
                            "x-morty-content-kind": metadata.kind,
                            "x-morty-file-name": encodeURIComponent(metadata.name),
                        },
                        method: "PUT",
                    },
                ),
            ),
        /** Signs the issued claims again, optionally with another lifetime, under the key `signer` derives. */
        resignCredential: async (signer: CredentialSigner, lifetimeMilliseconds?: number) => {
            // Sign adversarial claims outside the Relay issuer, which refuses invalid lifetimes.
            const decoded = decodeSessionAccessCredential(text(sessionAccess, "credential"));
            const claims =
                lifetimeMilliseconds === undefined
                    ? decoded.claims
                    : {
                          ...decoded.claims,
                          expiresAtEpochMilliseconds: decoded.claims.issuedAtEpochMilliseconds + lifetimeMilliseconds,
                      };
            const encode = (bytes: Uint8Array) =>
                btoa(String.fromCharCode(...bytes))
                    .replaceAll("+", "-")
                    .replaceAll("/", "_")
                    .replace(/=+$/u, "");
            const payload = encode(new TextEncoder().encode(JSON.stringify(claims)));
            const signedValue = `msession_${payload}`;
            const key = await signer();
            const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedValue));
            return `${signedValue}.${encode(new Uint8Array(signature))}`;
        },
        daemon,
        daemonClosed,
        daemonMessages,
        heartbeat,
        readOnline: async () => (await backend.agents(AbortSignal.timeout(10000)))["online"],
        /** Starts the submitted Turn: the Computer records its start and answers the submission as running. */
        startTurn: (commandId: string, position: string) => {
            daemon.send(
                encodeSessionEventEnvelope({
                    kind: "session.event.v2",
                    events: [
                        {
                            eventId: `${commandId}-started`,
                            position,
                            recordedAt: new Date().toISOString(),
                            sessionGenerationId: "session-generation-1",
                            target: nativeTarget(sessionId),
                            type: "lifecycle-metadata",
                            payload: {
                                attemptId: `${commandId}-attempt`,
                                commandId,
                                epoch: `${slug}-epoch`,
                                kind: "prompt.started",
                            },
                        },
                    ],
                }),
            );
            daemon.send(
                encodeSessionPromptAcceptedEvent({
                    kind: "session.prompt.accepted",
                    requestId: commandId,
                    target: nativeTarget(sessionId),
                    state: "running",
                }),
            );
        },
        issueComputerCredential: async (_targetComputerId: string) =>
            (await issueSession(computerId, nativeTarget(sessionId))).credential,
        queryActiveTurn: async (signal: AbortSignal) =>
            sessionRequest(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/active-turn`,
                    {
                        method: "GET",
                        headers: credentialHeaders(sessionAccess.credential),
                        signal,
                    },
                ),
            ),
        readFile: async (path: string) =>
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/files/content?${new URLSearchParams({ maxBytes: "1024", path }).toString()}`,
                    { headers: credentialHeaders(text(sessionAccess, "credential")) },
                ),
                environment,
            ),
        submitComputerTurn: (
            idempotencyKey: string,
            credentialTransform: (credential: string) => string = (credential) => credential,
            requestedSessionId: string = sessionId,
            destinationComputerId: string = computerId,
        ) =>
            requestBrowserOperation(
                (request) => env.COMPUTER_RELAY.getByName(computerObjectName(destinationComputerId)).fetch(request),
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${requestedSessionId}/turns`,
                    {
                        method: "POST",
                        headers: credentialHeaders(credentialTransform(text(sessionAccess, "credential"))),
                        body: JSON.stringify({
                            content: "Direct execution",
                            idempotencyKey,
                            attachments: [],
                        }),
                    },
                ),
            ),
        readSessionExecution: (commandId?: string) =>
            requestBrowserOperation(
                (request) => env.COMPUTER_RELAY.getByName(computerObjectName(computerId)).fetch(request),
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/active-turn?${new URLSearchParams(
                        commandId === undefined ? {} : { commandId },
                    ).toString()}`,
                    { headers: credentialHeaders(text(sessionAccess, "credential")) },
                ),
            ),
        submitTurn: (idempotencyKey: string) =>
            sessionRequest(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns`,
                    {
                        body: JSON.stringify({
                            content: `Run ${idempotencyKey}`,
                            idempotencyKey,
                            attachments: [],
                        }),
                        headers: credentialHeaders(text(sessionAccess, "credential")),
                        method: "POST",
                    },
                ),
            ),
    };
}

it.each(["text", "binary"])(
    "Given a connected Computer, When revocation commits but disconnect delivery fails and a %s message arrives, Then later events reach no viewer and the daemon is closed",
    async (format) => {
        const runtime = await connectComputerDaemon(`revoked-stream-${format}`);
        const { socket: viewer, messages, encryption, admission } = await runtime.subscribe();
        expect(admission).toMatchObject({ kind: "session.events.ready" });
        const received: string[] = [];
        viewer.addEventListener("message", (event) => {
            if (record(JSON.parse(String(event.data)))["kind"] === "session.events.event") {
                received.push(String(event.data));
            }
        });
        const deliver = (message: string | Uint8Array) =>
            runInDurableObject(
                env.COMPUTER_RELAY.getByName(computerObjectName(runtime.computerId)),
                async (_instance, state) => {
                    const pending: Promise<void>[] = [];
                    const database = new DurableObjectDatabase(state.storage);
                    const { access } = computerAccess(runtime.computerId, state.storage);
                    const context = createRelayDurableObjectContext(state, { database, access: () => access });
                    const relay = new DaemonWebSocketRoutes(
                        createRuntimeContext({
                            doDatabase: database,
                            services: context.services,
                            gateways: context.gateways,
                            utilities: {
                                waitUntil: (operation) => {
                                    pending.push(operation);
                                },
                            },
                        }),
                    );
                    const daemon = state.getWebSockets("daemon")[0];
                    if (daemon === undefined) {
                        throw new Error("Expected the accepted Computer connection");
                    }
                    await relay.webSocketMessage(
                        daemon,
                        typeof message === "string" ? message : new Uint8Array(message).buffer,
                    );
                    await Promise.all(pending);
                },
            );
        try {
            const signal = new AbortController().signal;
            const before = await sessionEventEnvelopeCodec.encode(
                JSON.parse(liveEvent(runtime.sessionTarget, "before revocation")),
                encryption.computer,
                signal,
            );
            await deliver(before);
            const delivered = text(record(JSON.parse(await messages.next())), "data");
            expect((await sessionEventEnvelopeCodec.decode(delivered, encryption.client, signal)).events).toMatchObject(
                [{ payload: { content: { text: "before revocation" } } }],
            );
            await runInDurableObject(
                env.COMPUTER_RELAY.getByName(computerObjectName(runtime.computerId)),
                (_instance, state) => {
                    state.storage.sql.exec(`CREATE TRIGGER reject_computer_disconnect BEFORE UPDATE OF disconnected_at ON computer_connection
                BEGIN SELECT RAISE(ABORT, 'Controlled disconnect failure'); END`);
                },
            );
            try {
                await expect(runtime.revoke()).rejects.toThrow();
            } finally {
                await runInDurableObject(
                    env.COMPUTER_RELAY.getByName(computerObjectName(runtime.computerId)),
                    (_instance, state) => {
                        state.storage.sql.exec("DROP TRIGGER reject_computer_disconnect");
                    },
                );
            }
            await deliver(
                format === "text"
                    ? await sessionEventEnvelopeCodec.encode(
                          JSON.parse(liveEvent(runtime.sessionTarget, "after revocation")),
                          encryption.computer,
                          signal,
                      )
                    : await contentChunkCodec.encode(
                          {
                              bytes: new Uint8Array([1, 2]),
                              requestId: "revoked-file",
                              sequence: 0,
                          },
                          encryption.computer,
                          signal,
                      ),
            );
            expect(await runtime.daemonClosed).toMatchObject({ code: 1008, reason: "Computer revoked" });
            expect(received).toHaveLength(1);
            expect((await runtime.revoke()).status).toBe(204);
        } finally {
            runtime.daemon.close(1000, "Test complete");
            viewer.close(1000, "Test complete");
        }
    },
);

it("Given a connected Computer, When revocation commits but disconnect delivery fails and its daemon retries, Then the daemon is told it was revoked and the earlier connection closes", async () => {
    const runtime = await connectComputerDaemon("revoked-retry");
    const { socket: viewer, admission } = await runtime.subscribe();
    expect(admission).toMatchObject({ kind: "session.events.ready" });
    try {
        await runInDurableObject(
            env.COMPUTER_RELAY.getByName(computerObjectName(runtime.computerId)),
            (_instance, state) => {
                state.storage.sql.exec(`CREATE TRIGGER reject_computer_disconnect BEFORE UPDATE OF disconnected_at ON computer_connection
                BEGIN SELECT RAISE(ABORT, 'Controlled disconnect failure'); END`);
            },
        );
        try {
            await expect(runtime.revoke()).rejects.toThrow();
        } finally {
            await runInDurableObject(
                env.COMPUTER_RELAY.getByName(computerObjectName(runtime.computerId)),
                (_instance, state) => {
                    state.storage.sql.exec("DROP TRIGGER reject_computer_disconnect");
                },
            );
        }
        const reconnected = await runtime.reconnect();
        expect(reconnected.status).toBe(101);
        const refused = reconnected.webSocket;
        if (refused === null) {
            throw new Error("Expected the refused Computer socket");
        }
        const refusal = new Promise<CloseEvent>((resolve) =>
            refused.addEventListener("close", resolve, { once: true }),
        );
        refused.accept();
        expect(await refusal).toMatchObject({ code: 1008, reason: "Computer revoked" });
        expect(await runtime.daemonClosed).toMatchObject({ code: 1008, reason: "Computer revoked" });
    } finally {
        runtime.daemon.close(1000, "Test complete");
        viewer.close(1000, "Test complete");
    }
});

it("Given a Computer its owner revoked and then paired again, When the earlier daemon reconnects with its saved credential, Then the Relay tells it the Computer was revoked while the new daemon connects", async () => {
    const runtime = await connectComputerDaemon("paired-again");
    try {
        expect((await runtime.revoke()).status).toBe(204);
        expect(await runtime.daemonClosed).toMatchObject({ code: 1008, reason: "Computer revoked" });
        const replacement = await runtime.pairAgain("paired-again-replacement");

        const earlier = await runtime.reconnect();

        expect(earlier.status).toBe(101);
        const refused = earlier.webSocket;
        if (refused === null) {
            throw new Error("Expected the refused Computer socket");
        }
        const refusal = new Promise<CloseEvent>((resolve) =>
            refused.addEventListener("close", resolve, { once: true }),
        );
        refused.accept();
        expect(await refusal).toMatchObject({ code: 1008, reason: "Computer revoked" });
        const connected = await runtime.connect(replacement);
        const daemon = connected.webSocket;
        if (daemon === null) {
            throw new Error("Expected the paired Computer socket");
        }
        const messages = new SocketMessages(daemon);
        daemon.accept();
        expect(decodeWorkerToDaemonMessage(await messages.next()).kind).toBe("computer.liveness.ready");
        daemon.close(1000, "Test complete");
    } finally {
        runtime.daemon.close(1000, "Test complete");
    }
});

it("Given a Session credential with an open live view, When the owner revokes the Computer and pairs the computer again, Then the credential is refused and its view closes while a credential issued under the new pairing opens a view", async () => {
    const runtime = await connectComputerDaemon("session-pairing-generation");
    try {
        const subscribed = await runtime.subscribe();
        expect(subscribed.admission).toMatchObject({ kind: "session.events.ready" });

        expect((await runtime.revoke()).status).toBe(204);
        // Computer revocation and credential reauthorization can both close the view.
        expect(JSON.parse(await subscribed.messages.next())).toMatchObject({ kind: "session.events.end" });
        await expect(runtime.issueComputerCredential(runtime.computerId)).rejects.toMatchObject({
            code: "credential_revoked",
        });
        const replacement = await runtime.connect(await runtime.pairAgain("session-pairing-generation-replacement"));
        const daemon = replacement.webSocket;
        if (daemon === null) {
            throw new Error("Expected the paired Computer socket");
        }
        const messages = new SocketMessages(daemon);
        daemon.accept();
        expect(decodeWorkerToDaemonMessage(await messages.next()).kind).toBe("computer.liveness.ready");

        expect((await runtime.subscribe()).admission).toMatchObject({
            kind: "session.events.error",
            status: 401,
            code: "credential_revoked",
        });
        const signal = new AbortController().signal;
        const encryption = await endpointEncryption(runtime.computerId, signal);
        const history = await sessionHistoryPageLoadCodec.encode(
            {
                kind: "session.live-history.v2.page.load",
                requestId: "revoked-history",
                target: runtime.sessionTarget,
                cursor: null,
                eventLimit: 50,
            },
            encryption.client,
            signal,
        );
        const request = new Request(
            `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/events`,
            { method: "GET", headers: credentialHeaders(runtime.credential), signal },
        );
        expect(
            await responseJson(await requestBrowserOperation((input) => ownerRequest(input), request, history), 401),
        ).toMatchObject({
            error: { code: "credential_revoked" },
        });
        const reopened = await runtime.subscribe(await runtime.issueComputerCredential(runtime.computerId));
        expect(reopened.admission).toMatchObject({ kind: "session.events.ready" });
        await closeBrowserSocket(reopened.socket, new AbortController().signal);
        daemon.close(1000, "Test complete");
    } finally {
        runtime.daemon.close(1000, "Test complete");
    }
});

it("Given Chat reads the Session execution naming an unconfirmed command, When the Computer reports that command's delivery, Then the Relay returns the delivery", async () => {
    const runtime = await connectComputerDaemon("command-delivery");
    try {
        const signal = new AbortController().signal;
        const encryption = await endpointEncryption(runtime.computerId, signal);
        const encoded = await nativeSessionRequestCodec.encode(
            {
                kind: "native.session.request",
                requestId: "delivery-read",
                action: "active-turn",
                target: runtime.sessionTarget,
                deliveryCommandId: "unconfirmed-command",
            },
            encryption.client,
            signal,
        );
        const request = new Request(
            `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/active-turn?commandId=unconfirmed-command`,
            { method: "GET", headers: credentialHeaders(runtime.credential), signal },
        );
        const response = requestBrowserOperation((input) => ownerRequest(input), request, encoded);
        const first = await Promise.race([
            runtime.daemonMessages.next().then((message) => ({ kind: "command" as const, message })),
            response.then((answered) => ({ kind: "response" as const, response: answered })),
        ]);
        if (first.kind === "response") {
            throw new Error(
                `Expected a daemon request, received ${first.response.status}: ${await first.response.text()}`,
            );
        }
        const query = await decodeEncryptedDaemonInboundMessage(first.message, encryption.computer, signal);
        if (query.kind !== "native.session.request" || query.action !== "active-turn") {
            throw new Error("Expected the Session execution read to reach the daemon");
        }
        expect(query.deliveryCommandId).toBe("unconfirmed-command");
        runtime.daemon.send(
            await nativeSessionResultCodec.encode(
                {
                    kind: "native.session.result",
                    action: "active-turn",
                    requestId: query.requestId,
                    target: runtime.sessionTarget,
                    turn: null,
                    queued: [],
                    command: { state: "completed", stopReason: "end_turn" },
                    executionPosition: { sessionGenerationId: "session-generation-1", throughPosition: "0" },
                    interactionState: null,
                },
                encryption.computer,
                signal,
            ),
        );
        const routed = await responseJson(await response, 200);
        expect(await nativeSessionResultCodec.decode(JSON.stringify(routed), encryption.client, signal)).toMatchObject({
            command: { state: "completed", stopReason: "end_turn" },
        });
    } finally {
        runtime.daemon.close(1000, "Test complete");
    }
});

it("Given Chat reads the Session execution after missing a turn's outcome, When the Computer reports the last turn, Then the Relay returns the outcome", async () => {
    const runtime = await connectComputerDaemon("last-turn");
    try {
        const signal = new AbortController().signal;
        const encryption = await endpointEncryption(runtime.computerId, signal);
        const encoded = await nativeSessionRequestCodec.encode(
            {
                kind: "native.session.request",
                requestId: "last-turn-read",
                action: "active-turn",
                target: runtime.sessionTarget,
            },
            encryption.client,
            signal,
        );
        const request = new Request(
            `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/active-turn`,
            { method: "GET", headers: credentialHeaders(runtime.credential), signal },
        );
        const response = requestBrowserOperation((input) => ownerRequest(input), request, encoded);
        const first = await Promise.race([
            runtime.daemonMessages.next().then((message) => ({ kind: "command" as const, message })),
            response.then((answered) => ({ kind: "response" as const, response: answered })),
        ]);
        if (first.kind === "response") {
            throw new Error(
                `Expected a daemon request, received ${first.response.status}: ${await first.response.text()}`,
            );
        }
        const query = await decodeEncryptedDaemonInboundMessage(first.message, encryption.computer, signal);
        if (query.kind !== "native.session.request" || query.action !== "active-turn") {
            throw new Error("Expected the Session execution read to reach the daemon");
        }
        expect(query).not.toHaveProperty("deliveryCommandId");
        runtime.daemon.send(
            await nativeSessionResultCodec.encode(
                {
                    kind: "native.session.result",
                    action: "active-turn",
                    requestId: query.requestId,
                    target: runtime.sessionTarget,
                    turn: null,
                    queued: [],
                    executionPosition: { sessionGenerationId: "session-generation-1", throughPosition: "0" },
                    interactionState: null,
                    lastTurn: {
                        code: "model_unavailable",
                        commandId: "failed-command",
                        message: "The local Agent could not complete the request",
                        state: "failed",
                    },
                },
                encryption.computer,
                signal,
            ),
        );
        const routed = await responseJson(await response, 200);
        expect(await nativeSessionResultCodec.decode(JSON.stringify(routed), encryption.client, signal)).toMatchObject({
            interactionState: null,
            lastTurn: { commandId: "failed-command", state: "failed", code: "model_unavailable" },
        });
    } finally {
        runtime.daemon.close(1000, "Test complete");
    }
});

describe.sequential("Relay Turn submission", () => {
    it.each(["session"] as const)(
        "Given %s access cancels a Turn, When the Computer reports cancellation or prior completion, Then the response reports the Turn's actual stop reason",
        async (access) => {
            const runtime = await connectComputerDaemon(`legacy-queue-cancel-${access.replace(" ", "-")}`);
            try {
                const signal = new AbortController().signal;
                const encryption = await endpointEncryption(runtime.computerId, signal);
                for (const stopReason of ["cancelled", "end_turn"] as const) {
                    const turnId = `legacy-${stopReason}`;
                    const encoded = await sessionCancelCommandCodec.encode(
                        {
                            kind: "session.cancel",
                            requestId: `cancel-${stopReason}`,
                            commandId: turnId,
                            target: runtime.sessionTarget,
                        },
                        encryption.client,
                        signal,
                    );
                    const request = new Request(
                        `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/turns/${turnId}/cancel`,
                        { method: "POST", headers: credentialHeaders(runtime.credential), body: encoded, signal },
                    );
                    const response = requestBrowserOperation((input) => ownerRequest(input), request);
                    const cancellation = await decodeEncryptedDaemonInboundMessage(
                        await runtime.daemonMessages.next(),
                        encryption.computer,
                        signal,
                    );
                    expect(cancellation).toEqual({
                        commandId: turnId,
                        kind: "session.cancel",
                        requestId: expect.any(String),
                        target: runtime.sessionTarget,
                    });
                    if (cancellation.kind !== "session.cancel") {
                        throw new Error("Expected a cancellation");
                    }
                    runtime.daemon.send(
                        await sessionTurnStoppedEventCodec.encode(
                            {
                                commandId: turnId,
                                kind: "session.turn.stopped",
                                requestId: cancellation.requestId,
                                target: runtime.sessionTarget,
                                stopReason,
                            },
                            encryption.computer,
                            signal,
                        ),
                    );
                    const routed = await responseJson(await response, 200);
                    expect(
                        await sessionTurnStoppedEventCodec.decode(JSON.stringify(routed), encryption.client, signal),
                    ).toMatchObject({ commandId: turnId, stopReason });
                }
            } finally {
                runtime.daemon.close(1000, "Test complete");
            }
        },
    );

    it.each(["session"] as const)(
        "Given %s access withdraws a queued message, When the Computer refuses because it already started, Then the conditional endpoint rejects the edit",
        async (access) => {
            const runtime = await connectComputerDaemon(`conditional-queue-cancel-${access}`);
            try {
                const signal = new AbortController().signal;
                const encryption = await endpointEncryption(runtime.computerId, signal);
                const encoded = await sessionCancelBeforeStartCommandCodec.encode(
                    {
                        kind: "session.cancel-before-start",
                        requestId: "withdraw-request",
                        commandId: "queued-command",
                        target: runtime.sessionTarget,
                    },
                    encryption.client,
                    signal,
                );
                const request = new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/turns/queued-command/cancel-before-start`,
                    { method: "POST", headers: credentialHeaders(runtime.credential), body: encoded, signal },
                );
                const response = requestBrowserOperation((input) => ownerRequest(input), request);
                const withdrawal = await decodeEncryptedDaemonInboundMessage(
                    await runtime.daemonMessages.next(),
                    encryption.computer,
                    signal,
                );
                expect(withdrawal).toEqual({
                    commandId: "queued-command",
                    kind: "session.cancel-before-start",
                    requestId: expect.any(String),
                    target: runtime.sessionTarget,
                });
                if (withdrawal.kind !== "session.cancel-before-start") {
                    throw new Error("Expected a withdrawal");
                }
                runtime.daemon.send(
                    await sessionOperationFailedEventCodec.encode(
                        {
                            kind: "session.operation.failed",
                            requestId: withdrawal.requestId,
                            target: runtime.sessionTarget,
                            code: "turn_already_started",
                            message: "The message already started and could not be withdrawn",
                        },
                        encryption.computer,
                        signal,
                    ),
                );
                const routed = await responseJson(await response, 200);
                expect(
                    await sessionOperationFailedEventCodec.decode(JSON.stringify(routed), encryption.client, signal),
                ).toMatchObject({ code: "turn_already_started" });
            } finally {
                runtime.daemon.close(1000, "Test complete");
            }
        },
    );

    // @no-uc: Compatibility; trusted backends must control a Computer Session without delegated Session access.
    it.each([
        {
            label: "cancels the selected message",
            path: "/turns/app-command/cancel",
            method: "POST",
            body: {},
            command: { commandId: "app-command", kind: "session.cancel" },
            reply: { commandId: "app-command", kind: "session.turn.stopped", stopReason: "cancelled" },
            expected: { turnId: "app-command", stopReason: "cancelled" },
        },
        {
            label: "cancels the selected message only before it starts",
            path: "/turns/app-command/cancel-before-start",
            method: "POST",
            body: {},
            command: { commandId: "app-command", kind: "session.cancel-before-start" },
            reply: { commandId: "app-command", kind: "session.turn.withdrawn" },
            expected: { turnId: "app-command" },
        },
        {
            label: "steers the selected queued message",
            path: "/turns/app-command/disposition",
            method: "PUT",
            body: { disposition: "steer" },
            command: { commandId: "app-command", disposition: "steer", kind: "session.prompt.disposition" },
            reply: { commandId: "app-command", kind: "session.prompt.steered" },
            expected: { turnId: "app-command" },
        },
        {
            label: "answers a pending permission request",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "permission", responderId: "member-1", outcome: "selected", optionId: "allow_once" },
            command: {
                interactionId: "app-interaction",
                kind: "session.permission.respond",
                outcome: "selected",
                optionId: "allow_once",
            },
            reply: { interactionId: "app-interaction", kind: "session.interaction.answered" },
            expected: { accepted: true },
        },
        {
            label: "answers a pending elicitation request",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "elicitation", responderId: "member-1", action: "accept", content: '{"answer":"continue"}' },
            command: {
                interactionId: "app-interaction",
                kind: "session.elicitation.respond",
                action: "accept",
                content: '{"answer":"continue"}',
            },
            reply: { interactionId: "app-interaction", kind: "session.interaction.answered" },
            expected: { accepted: true },
        },
    ] as const)("Session access $label", async (operation) => {
        const runtime = await connectComputerDaemon(`app-control-${operation.command.kind.replaceAll(".", "-")}`);
        try {
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(runtime.computerId, signal);
            const encoded = await encodeEncryptedDaemonInboundMessage(
                { ...operation.command, requestId: "app-control", target: runtime.sessionTarget },
                encryption.client,
                signal,
            );
            const request = new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}${operation.path}`,
                { method: operation.method, headers: credentialHeaders(runtime.credential), body: encoded, signal },
            );
            const response = requestBrowserOperation((input) => ownerRequest(input), request);
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const command = await decodeEncryptedDaemonInboundMessage(first.message, encryption.computer, signal);
            expect(command).toMatchObject({ ...operation.command, target: runtime.sessionTarget });
            if (!("requestId" in command)) {
                throw new Error("Expected the command to name its own request");
            }
            runtime.daemon.send(
                await encodeEncryptedDaemonMessage(
                    { ...operation.reply, requestId: command.requestId, target: runtime.sessionTarget },
                    encryption.computer,
                    signal,
                ),
            );
            const routed = await responseJson(await response, 200);
            expect(await decodeEncryptedDaemonMessage(JSON.stringify(routed), encryption.client, signal)).toMatchObject(
                operation.reply,
            );
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    // @no-uc: Technical regression; a read-only App credential must load a Computer event page through its cursor.
    it("Session access restores a Computer event page with read permission", async () => {
        const runtime = await connectComputerDaemon("app-history");
        try {
            const readOnly = await runtime.issueComputerCredential(runtime.computerId);
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(runtime.computerId, signal);
            const encoded = await sessionHistoryPageLoadCodec.encode(
                {
                    kind: "session.live-history.v2.page.load",
                    requestId: "history-read",
                    target: runtime.sessionTarget,
                    eventLimit: 2,
                    cursor: "previous-event",
                },
                encryption.client,
                signal,
            );
            const request = new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/events?limit=2&cursor=previous-event`,
                { method: "GET", headers: credentialHeaders(readOnly), signal },
            );
            const response = requestBrowserOperation((input) => ownerRequest(input), request, encoded);
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const command = await decodeEncryptedDaemonInboundMessage(first.message, encryption.computer, signal);
            expect(command).toMatchObject({
                kind: "session.live-history.v2.page.load",
                target: runtime.sessionTarget,
                eventLimit: 2,
                cursor: "previous-event",
            });
            if (command.kind !== "session.live-history.v2.page.load") {
                throw new Error("Expected a history request");
            }
            const page = {
                events: [],
                nextCursor: "next-event",
                sessionGenerationId: "session-generation-1",
                tailCursor: "tail-event",
                throughPosition: "3",
                truncated: true,
                version: 2 as const,
            };
            runtime.daemon.send(
                await sessionHistoryPageLoadedCodec.encode(
                    {
                        kind: "session.live-history.v2.page.loaded",
                        requestId: command.requestId,
                        target: runtime.sessionTarget,
                        events: { events: page, queuedPromptRequests: [] },
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const routed = await responseJson(await response, 200);
            const result = await sessionHistoryPageLoadedCodec.decode(
                JSON.stringify(routed),
                encryption.client,
                signal,
            );
            expect(result.events.events).toEqual(page);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it("Given Computer read permission, When an App reads Session configuration, Then the matching Computer settings are returned without write permission", async () => {
        const runtime = await connectComputerDaemon("app-configuration-read");
        try {
            const readOnly = await runtime.issueComputerCredential(runtime.computerId);
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(runtime.computerId, signal);
            const encoded = await sessionConfigReadCommandCodec.encode(
                { kind: "session.config.read", requestId: "config-read", target: runtime.sessionTarget },
                encryption.client,
                signal,
            );
            const request = new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/configuration`,
                { method: "GET", headers: credentialHeaders(readOnly), signal },
            );
            const response = requestBrowserOperation((input) => ownerRequest(input), request, encoded);
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                response.then((result) => ({ kind: "response", message: String(result.status) })),
            ]);
            expect(first).toMatchObject({ kind: "command" });
            const command = await decodeEncryptedDaemonInboundMessage(first.message, encryption.computer, signal);
            expect(command).toMatchObject({ kind: "session.config.read", target: runtime.sessionTarget });
            if (command.kind !== "session.config.read") {
                throw new Error("Expected a configuration request");
            }
            const result: SessionConfigReadResult = {
                kind: "session.config.read.result",
                requestId: command.requestId,
                target: runtime.sessionTarget,
                configurationRevision: "revision-1",
                configOptions: [],
            };
            runtime.daemon.send(await sessionConfigReadResultCodec.encode(result, encryption.computer, signal));
            const routed = await responseJson(await response, 200);
            expect(
                await sessionConfigReadResultCodec.decode(JSON.stringify(routed), encryption.client, signal),
            ).toEqual(result);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it.each([
        {
            label: "unsupported append disposition",
            path: "/turns/app-command/disposition",
            method: "PUT",
            body: { disposition: "append" },
        },
        {
            label: "invalid permission decision",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "permission", responderId: "member-1", outcome: "unknown", optionId: "allow_once" },
        },
        {
            label: "invalid elicitation decision",
            path: "/interactions/app-interaction/responses",
            method: "POST",
            body: { kind: "elicitation", responderId: "member-1", action: "unknown", content: "" },
        },
        { label: "empty event page", path: "/events?limit=0", method: "GET" },
        { label: "empty event cursor", path: "/events?cursor=", method: "GET" },
    ])("Session access reports $label as an invalid request", async (operation) => {
        const runtime = await connectComputerDaemon("app-invalid-request");
        try {
            if (operation.method === "GET") {
                const signal = new AbortController().signal;
                const encryption = await endpointEncryption(runtime.computerId, signal);
                await expect(
                    sessionHistoryPageLoadCodec.encode(
                        {
                            kind: "session.live-history.v2.page.load",
                            requestId: "invalid-history",
                            target: runtime.sessionTarget,
                            eventLimit: operation.label === "empty event page" ? 0 : 50,
                            cursor: operation.label === "empty event cursor" ? "" : null,
                        },
                        encryption.client,
                        signal,
                    ),
                ).rejects.toMatchObject({ code: "invalid_protocol_message" });
                expect(
                    await responseJson(await runtime.appSessionRequest(operation.path, operation), 400),
                ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
                return;
            }
            expect(await responseJson(await runtime.appSessionRequest(operation.path, operation), 400)).toMatchObject({
                error: { code: "invalid_request" },
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it("Session access uploads encrypted attachment chunks before submitting a reference-only Turn", async () => {
        const runtime = await connectComputerDaemon("app-binary-attachment");
        try {
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(runtime.computerId, signal);
            const bytes = new Uint8Array(400 * 1024).map((_value, index) => index % 251);
            const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
            const contentKey = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
            const metadata = {
                kind: "image" as const,
                mediaType: "image/png",
                name: "screenshot.png",
                uri: "attachment:///screenshot.png",
            };
            const requestId = "upload-attachment";
            const write = await contentWriteCommandCodec.encode(
                {
                    kind: "content.write",
                    requestId,
                    target: runtime.sessionTarget,
                    byteLength: bytes.byteLength,
                    contentKey,
                    contentKind: metadata.kind,
                    mediaType: metadata.mediaType,
                    name: metadata.name,
                },
                encryption.client,
                signal,
            );
            const records = [encodeFileStreamRecord({ kind: "message", encoded: write })];
            for (
                let offset = 0, sequence = 0;
                offset < bytes.byteLength;
                offset += CONTENT_CHUNK_MAX_BYTES, sequence += 1
            ) {
                const chunk = await contentChunkCodec.encode(
                    { requestId, sequence, bytes: bytes.subarray(offset, offset + CONTENT_CHUNK_MAX_BYTES) },
                    encryption.client,
                    signal,
                );
                records.push(encodeFileStreamRecord({ kind: "chunk", encoded: chunk }));
            }
            const commit = await contentCommitCommandCodec.encode(
                { kind: "content.commit", requestId, target: runtime.sessionTarget },
                encryption.client,
                signal,
            );
            records.push(encodeFileStreamRecord({ kind: "message", encoded: commit }));
            const wire = new Uint8Array(records.reduce((total, record) => total + record.byteLength, 0));
            let position = 0;
            for (const record of records) {
                wire.set(record, position);
                position += record.byteLength;
            }
            const uploadRequest = new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/content/${contentKey}`,
                {
                    method: "PUT",
                    headers: {
                        authorization: `Bearer ${runtime.credential}`,
                        "content-type": FILE_STREAM_CONTENT_TYPE,
                        "x-morty-byte-length": String(wire.byteLength),
                    },
                    body: wire,
                    signal,
                },
            );
            const upload = requestBrowserOperation((input) => ownerRequest(input), uploadRequest);
            const receivedWrite = await decodeEncryptedDaemonInboundMessage(
                await runtime.daemonMessages.next(),
                encryption.computer,
                signal,
            );
            expect(receivedWrite).toMatchObject({
                byteLength: bytes.byteLength,
                contentKey,
                contentKind: "image",
                kind: "content.write",
                target: runtime.sessionTarget,
            });
            if (receivedWrite.kind !== "content.write") {
                throw new Error("Expected a content write command");
            }
            runtime.daemon.send(
                await contentReadyEventCodec.encode(
                    { kind: "content.ready", requestId, target: runtime.sessionTarget },
                    encryption.computer,
                    signal,
                ),
            );
            const chunks: Uint8Array[] = [];
            for (;;) {
                const frame = await runtime.daemonMessages.nextFrame();
                if (typeof frame === "string") {
                    const command = await decodeEncryptedDaemonInboundMessage(frame, encryption.computer, signal);
                    if (command.kind === "content.commit" && command.requestId === requestId) {
                        break;
                    }
                    continue;
                }
                const arrayBuffer =
                    typeof frame === "object" && frame !== null ? Reflect.get(frame, "arrayBuffer") : undefined;
                const binary = typeof arrayBuffer === "function" ? await Reflect.apply(arrayBuffer, frame, []) : frame;
                const chunk = await contentChunkCodec.decode(binary, encryption.computer, signal);
                expect(chunk.requestId).toBe(requestId);
                expect(chunk.sequence).toBe(chunks.length);
                chunks.push(chunk.bytes);
            }
            const uploadedBytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
            let offset = 0;
            for (const chunk of chunks) {
                uploadedBytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            expect(uploadedBytes).toEqual(bytes);
            expect(chunks.length).toBeGreaterThan(1);
            runtime.daemon.send(
                await contentAvailableEventCodec.encode(
                    {
                        kind: "content.available",
                        requestId,
                        target: runtime.sessionTarget,
                        contentKey,
                        byteLength: bytes.byteLength,
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const routedAvailable = await responseJson(await upload, 200);
            const available = await contentAvailableEventCodec.decode(
                JSON.stringify(routedAvailable),
                encryption.client,
                signal,
            );
            expect(available).toMatchObject({ byteLength: bytes.byteLength, contentKey });
            const attachment = {
                byteLength: bytes.byteLength,
                contentKey,
                kind: metadata.kind,
                mimeType: metadata.mediaType,
                name: metadata.name,
                uri: metadata.uri,
            };
            const idempotencyKey = "binary-attachment-turn";
            const prompt = await sessionPromptCommandCodec.encode(
                {
                    kind: "session.prompt",
                    requestId: "binary-attachment-request",
                    commandId: idempotencyKey,
                    target: runtime.sessionTarget,
                    prompt: "Describe the pasted screenshot.",
                    attachments: [attachment],
                    disposition: "append",
                    sessionConfigurations: [],
                },
                encryption.client,
                signal,
            );
            const promptRequest = new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/turns`,
                { method: "POST", headers: credentialHeaders(runtime.credential), body: prompt, signal },
            );
            const response = requestBrowserOperation((input) => ownerRequest(input), promptRequest);
            const encodedPrompt = await runtime.daemonMessages.next();
            expect(encodedPrompt).not.toContain("base64");
            expect(encodedPrompt).not.toContain(String(bytes.slice(0, 32)));
            expect(await decodeEncryptedDaemonInboundMessage(encodedPrompt, encryption.computer, signal)).toMatchObject(
                { attachments: [attachment], kind: "session.prompt", commandId: idempotencyKey },
            );
            runtime.daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "binary-attachment-request",
                        target: runtime.sessionTarget,
                        state: "running",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const routed = await responseJson(await response, 200);
            expect(
                await sessionPromptAcceptedEventCodec.decode(JSON.stringify(routed), encryption.client, signal),
            ).toMatchObject({ requestId: "binary-attachment-request", state: "running" });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    it("Given a cancelled file response, When a late chunk arrives, Then the shared daemon remains available", async () => {
        const runtime = await connectComputerDaemon("cancelled-file-chunk");
        try {
            const signal = new AbortController().signal;
            const { computer: daemonEncryption, client: clientEncryption } = await endpointEncryption(
                runtime.computerId,
                signal,
            );
            const pending = runtime.readFile("/workspace/image.png");
            const read = decodeFileReadCommand(await runtime.daemonMessages.next());
            runtime.daemon.send(
                await fileBeginEventCodec.encode(
                    {
                        byteLength: 2,
                        kind: "file.begin",
                        mediaType: "image/png",
                        modifiedAt: "2026-09-18T00:00:00.000Z",
                        name: "image.png",
                        requestId: read.requestId,
                        target: runtime.sessionTarget,
                    },
                    daemonEncryption,
                    signal,
                ),
            );
            const response = await pending;
            await response.body?.cancel();

            runtime.daemon.send(
                await contentChunkCodec.encode(
                    {
                        bytes: new Uint8Array([1, 2]),
                        requestId: read.requestId,
                        sequence: 0,
                    },
                    daemonEncryption,
                    signal,
                ),
            );

            const encoded = await nativeSessionRequestCodec.encode(
                {
                    kind: "native.session.request",
                    requestId: "after-late-file",
                    action: "active-turn",
                    target: runtime.sessionTarget,
                },
                clientEncryption,
                signal,
            );
            const request = new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/active-turn`,
                { method: "GET", headers: credentialHeaders(runtime.credential), signal },
            );
            const query = requestBrowserOperation((input) => ownerRequest(input), request, encoded);
            const command = await decodeEncryptedDaemonInboundMessage(
                await runtime.daemonMessages.next(),
                daemonEncryption,
                signal,
            );
            if (command.kind !== "native.session.request") {
                throw new Error("Expected an unrelated native query to reach the daemon");
            }
            runtime.daemon.send(
                await nativeSessionResultCodec.encode(
                    {
                        action: "active-turn",
                        kind: "native.session.result",
                        queued: [],
                        executionPosition: { sessionGenerationId: "session-generation-1", throughPosition: "0" },
                        interactionState: null,
                        requestId: command.requestId,
                        target: runtime.sessionTarget,
                        turn: null,
                    },
                    daemonEncryption,
                    signal,
                ),
            );
            const routed = await responseJson(await query, 200);
            expect(
                await nativeSessionResultCodec.decode(JSON.stringify(routed), clientEncryption, signal),
            ).toMatchObject({ action: "active-turn", turn: null });
            expect(runtime.daemon.readyState).toBe(WebSocket.OPEN);
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });

    // @no-uc: Technical regression; independent Durable Object clocks must not reject newly issued credentials.
    it.each([900, 30_000])(
        "accepts a Session credential issued %i milliseconds ahead of ComputerRelay",
        async (skew) => {
            const runtime = await connectComputerDaemon(`clock-skew-${skew}`);
            try {
                vi.setSystemTime(Date.now() - skew);
                const signal = new AbortController().signal;
                const encryption = await endpointEncryption(runtime.computerId, signal);
                const encoded = await sessionPromptCommandCodec.encode(
                    {
                        kind: "session.prompt",
                        requestId: "skewed-request",
                        commandId: "skewed-command",
                        target: runtime.sessionTarget,
                        prompt: "Direct execution",
                        disposition: "append",
                        attachments: [],
                    },
                    encryption.client,
                    signal,
                );
                const request = new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/turns`,
                    { method: "POST", headers: credentialHeaders(runtime.credential), body: encoded, signal },
                );
                const submitted = requestBrowserOperation((input) => ownerRequest(input), request);
                const first = await Promise.race([
                    runtime.daemonMessages.next().then((message) => ({ kind: "command" as const, message })),
                    submitted.then((response) => ({ kind: "response" as const, response })),
                ]);
                if (first.kind === "response") {
                    throw new Error(
                        `Expected a daemon command, received ${first.response.status}: ${await first.response.text()}`,
                    );
                }
                expect(
                    await decodeEncryptedDaemonInboundMessage(first.message, encryption.computer, signal),
                ).toMatchObject({
                    kind: "session.prompt",
                    commandId: "skewed-command",
                    requestId: "skewed-command",
                });
                runtime.daemon.send(
                    await sessionPromptAcceptedEventCodec.encode(
                        {
                            kind: "session.prompt.accepted",
                            requestId: "skewed-request",
                            target: runtime.sessionTarget,
                            state: "running",
                        },
                        encryption.computer,
                        signal,
                    ),
                );
                const routed = await responseJson(await submitted, 200);
                expect(
                    await sessionPromptAcceptedEventCodec.decode(JSON.stringify(routed), encryption.client, signal),
                ).toMatchObject({ requestId: "skewed-request", state: "running" });
            } finally {
                runtime.daemon.close(1000, "Test complete");
            }
        },
    );
    // @no-uc: Technical regression; issuance tolerance must remain bounded and never extend expiry.
    it.each([
        { offset: -30_001, code: "credential_invalid" },
        { offset: 900_000, code: "credential_expired" },
    ])("refuses a credential at verifier offset $offset with $code", async ({ offset, code }) => {
        const runtime = await connectComputerDaemon(`clock-rejected-${Math.abs(offset)}`);
        try {
            vi.setSystemTime(Date.now() + offset);
            expect(await responseJson(await runtime.submitComputerTurn("invalid-time"), 401)).toMatchObject({
                error: { code },
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    // @no-uc: Technical regression; future-time tolerance must not admit correctly signed invalid lifetimes.
    it.each([0, -1, 900_001])("refuses a signed credential with lifetime %i", async (lifetime) => {
        const runtime = await connectComputerDaemon(`invalid-lifetime-${Math.abs(lifetime)}`);
        try {
            const credential = await runtime.resignCredential(relaySigner, lifetime);
            vi.setSystemTime(Date.now() - 900);
            expect(
                await responseJson(await runtime.submitComputerTurn("invalid-lifetime", () => credential), 401),
            ).toMatchObject({ error: { code: "credential_invalid" } });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given an authorized token for another computer, When it selects an existing computer's object, Then that object refuses the computer mismatch", async () => {
        const owner = await connectComputerDaemon("direct-owner");
        const other = await connectComputerDaemon("direct-other-computer");
        try {
            const credential = await other.issueComputerCredential(owner.computerId);
            expect(
                await responseJson(
                    await other.submitComputerTurn("foreign-computer", () => credential, undefined, owner.computerId),
                    421,
                ),
            ).toMatchObject({ error: { code: "computer_id_mismatch" } });
        } finally {
            owner.daemon.close(1000, "Test complete");
            other.daemon.close(1000, "Test complete");
        }
    });
    it("Given an executing native query, When its HTTP caller cancels, Then cancellation reaches the daemon", async () => {
        const runtime = await connectComputerDaemon("direct-cancellation");
        const controller = new AbortController();
        try {
            const { computer: daemonEncryption, client: clientEncryption } = await endpointEncryption(
                runtime.computerId,
                controller.signal,
            );
            const encoded = await nativeSessionRequestCodec.encode(
                {
                    kind: "native.session.request",
                    requestId: "cancel-native-request",
                    action: "active-turn",
                    target: runtime.sessionTarget,
                },
                clientEncryption,
                controller.signal,
            );
            const request = new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/active-turn`,
                { method: "GET", headers: credentialHeaders(runtime.credential), signal: controller.signal },
            );
            const pending = requestBrowserOperation((input) => ownerRequest(input), request, encoded).then(
                (response) => response.status,
                (cause: unknown) => cause,
            );
            const command = await decodeEncryptedDaemonInboundMessage(
                await runtime.daemonMessages.next(),
                daemonEncryption,
                controller.signal,
            );
            if (command.kind !== "native.session.request") {
                throw new Error("Expected a native query");
            }
            controller.abort(new DOMException("Caller left", "AbortError"));
            expect(decodeWorkerToDaemonMessage(await runtime.daemonMessages.next())).toMatchObject({
                kind: "worker.request.cancel",
                requestId: command.requestId,
            });
            expect(await pending).toBeInstanceOf(DOMException);
        } finally {
            controller.abort();
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given a Session credential, When direct Computer HTTP receives a forged, wrong-Session, or expired credential, Then it rejects the request before execution", async () => {
        const runtime = await connectComputerDaemon("direct-authorization");
        try {
            expect(
                await responseJson(
                    await runtime.submitComputerTurn("forged", (credential) => `${credential.slice(0, -6)}AAAAAA`),
                    401,
                ),
            ).toMatchObject({ error: { code: "credential_invalid" } });
            expect(
                await responseJson(
                    await runtime.submitComputerTurn("wrong-session", (credential) => credential, "different-session"),
                    403,
                ),
            ).toMatchObject({ error: { code: "session_permission_denied" } });
            vi.setSystemTime(new Date("2026-09-18T00:16:00.000Z"));
            expect(await responseJson(await runtime.submitComputerTurn("expired"), 401)).toMatchObject({
                error: { code: "credential_expired" },
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given an unrelated credential digest, When a Session credential is signed with it, Then direct Computer HTTP rejects it before execution", async () => {
        const runtime = await connectComputerDaemon("stored-digest-forgery");
        try {
            const forged = await runtime.resignCredential(storedDigestSigner);
            expect(
                await responseJson(await runtime.submitComputerTurn("stored-digest", () => forged), 401),
            ).toMatchObject({ error: { code: "credential_invalid" } });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given an open Session view, When the Relay signing secret rotates, Then the connection check closes the old view and only new credentials reconnect", async () => {
        const runtime = await connectComputerDaemon("signing-key-rotation");
        const { socket: view, messages } = await runtime.subscribe();
        try {
            const signingSecret = "rotated-test-only-session-signing-secret";
            const reissued = await runtime.resignCredential(async () => await relaySigningKey(signingSecret));
            const statuses = await runInDurableObject(
                env.COMPUTER_RELAY.getByName(computerObjectName(runtime.computerId)),
                async (_instance, state) => {
                    // Reconstruct the production object with the same persisted sockets and a newly deployed binding.
                    const rotated = new RelayComputerRelay(state, {
                        ...bindings(),
                        MORTY_ALLOWED_ORIGINS: '["*"]',
                        MORTY_SESSION_SIGNING_SECRET: signingSecret,
                    });
                    await rotated.alarm();
                    const cleanup: (() => Promise<void>)[] = [];
                    const connect = async (credential: string) =>
                        await openBrowserSubscription(
                            (request) => rotated.fetch(request),
                            new Request(
                                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/events`,
                                { headers: { authorization: `Bearer ${credential}`, Upgrade: "websocket" } },
                            ),
                            (close) => {
                                cleanup.push(close);
                            },
                        );
                    try {
                        const rejected = await connect(runtime.credential);
                        const accepted = await connect(reissued);
                        return { old: rejected.admission, current: accepted.admission };
                    } finally {
                        // These sockets belong to this DO execution, not to the test runner's later cleanup hook.
                        for (const close of cleanup) {
                            await close();
                        }
                    }
                },
            );
            expect(statuses).toMatchObject({
                old: { kind: "session.events.error", status: 401 },
                current: { kind: "session.events.ready" },
            });
            expect(JSON.parse(await messages.next())).toMatchObject({ kind: "session.events.end" });
        } finally {
            view.close(1000, "Test complete");
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given a Session credential, When the transport reaches ComputerRelay directly, Then the command executes without another relay hop and remains correlated", async () => {
        const runtime = await connectComputerDaemon("direct-runtime");
        try {
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(runtime.computerId, signal);
            const encoded = await sessionPromptCommandCodec.encode(
                {
                    kind: "session.prompt",
                    requestId: "direct-request",
                    commandId: "direct-command",
                    target: runtime.sessionTarget,
                    prompt: "Direct execution",
                    disposition: "append",
                    attachments: [],
                },
                encryption.client,
                signal,
            );
            const request = new Request(
                `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/turns`,
                { method: "POST", headers: credentialHeaders(runtime.credential), body: encoded, signal },
            );
            const submitted = requestBrowserOperation(
                (input) => env.COMPUTER_RELAY.getByName(computerObjectName(runtime.computerId)).fetch(input),
                request,
            );
            const first = await Promise.race([
                runtime.daemonMessages.next().then((message) => ({ kind: "command", message })),
                submitted.then((response) => ({ kind: "response", message: String(response.status) })),
            ]);
            expect(first.kind).toBe("command");
            expect(await decodeEncryptedDaemonInboundMessage(first.message, encryption.computer, signal)).toMatchObject(
                {
                    kind: "session.prompt",
                    commandId: "direct-command",
                    requestId: "direct-request",
                },
            );
            runtime.daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "direct-request",
                        target: runtime.sessionTarget,
                        state: "running",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const routed = await responseJson(await submitted, 200);
            expect(
                await sessionPromptAcceptedEventCodec.decode(JSON.stringify(routed), encryption.client, signal),
            ).toMatchObject({ requestId: "direct-request", state: "running" });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    });
    it("Given a linked Computer, When Chat submits a first Turn longer than 10,000 characters or an invalid Turn, Then the long Turn reaches the Computer and the invalid Turn is rejected as a client error", async () => {
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration());
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "long-prompt-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${text(pairing, "computerId")}/pairing/redeem`,
                    {
                        body: JSON.stringify({
                            agents: readyAgents,
                            computerName: "Long prompt Computer",
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: "long-prompt-workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
                environment,
            ),
            200,
        );
        const sessionId = "long-prompt-session";
        const daemonCredential = new DaemonCredential(text(claimed, "computerCredential"));
        const daemonResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
        if (daemonResponse.webSocket === null) {
            throw new Error("Expected the Computer socket");
        }
        const daemon = daemonResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        daemon.accept();
        try {
            expect(decodeWorkerToDaemonMessage(await daemonMessages.next()).kind).toBe("computer.liveness.ready");
            const sessionAccess = await issueSession(computerId, nativeTarget(sessionId));
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(computerId, signal);
            const sessionRequest = (request: Request) =>
                requestBrowserOperation((operation) => worker.fetch(operation, environment), request);
            const submitTurn = async (idempotencyKey: string, content: string, attachments: readonly unknown[]) => {
                const encoded = await sessionPromptCommandCodec.encode(
                    {
                        kind: "session.prompt",
                        requestId: idempotencyKey,
                        commandId: idempotencyKey,
                        target: nativeTarget(sessionId),
                        prompt: content,
                        attachments,
                        disposition: "append",
                    },
                    encryption.client,
                    signal,
                );
                return await sessionRequest(
                    new Request(
                        `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns`,
                        {
                            body: encoded,
                            headers: credentialHeaders(text(sessionAccess, "credential")),
                            method: "POST",
                        },
                    ),
                );
            };

            // First Turns carry the teammate's instructions ahead of the user's message.
            const longPrompt = `${"instruction ".repeat(2_000)}\n\nsummarize the workspace`;
            expect(longPrompt.length).toBeGreaterThan(20_000);
            const longTurn = submitTurn("long-first-turn", longPrompt, []);
            const delivered = await decodeEncryptedDaemonInboundMessage(
                await daemonMessages.next(),
                encryption.computer,
                signal,
            );
            if (delivered.kind !== "session.prompt") {
                throw new Error("Expected the long Turn to reach the Computer");
            }
            expect(delivered.prompt).toBe(longPrompt);
            expect(delivered.requestId).toBe(delivered.commandId);
            daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: delivered.commandId,
                        target: nativeTarget(sessionId),
                        state: "running",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const accepted = await responseJson(await longTurn, 200);
            expect(
                await sessionPromptAcceptedEventCodec.decode(JSON.stringify(accepted), encryption.client, signal),
            ).toMatchObject({ state: "running", requestId: "long-first-turn" });

            // A cancellation is answered only by the reply naming its own request: a failure naming the Turn it
            // cancels, or another Turn's lifecycle, leaves it waiting.
            const cancelEncoded = await sessionCancelCommandCodec.encode(
                {
                    kind: "session.cancel",
                    requestId: "cancel-long-first",
                    commandId: "long-first-turn",
                    target: nativeTarget(sessionId),
                },
                encryption.client,
                signal,
            );
            const cancelTurn = sessionRequest(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns/long-first-turn/cancel`,
                    {
                        body: cancelEncoded,
                        headers: credentialHeaders(text(sessionAccess, "credential")),
                        method: "POST",
                    },
                ),
            );
            const cancellation = await decodeEncryptedDaemonInboundMessage(
                await daemonMessages.next(),
                encryption.computer,
                signal,
            );
            if (cancellation.kind !== "session.cancel") {
                throw new Error("Expected the cancellation to reach the Computer");
            }
            expect(cancellation.requestId).not.toBe(cancellation.commandId);
            daemon.send(
                await sessionOperationFailedEventCodec.encode(
                    {
                        code: "agent_execution_failed",
                        kind: "session.operation.failed",
                        message: "The local agent could not complete the request",
                        requestId: "long-first-turn",
                        target: nativeTarget(sessionId),
                    },
                    encryption.computer,
                    signal,
                ),
            );
            daemon.send(
                await sessionEventEnvelopeCodec.encode(
                    {
                        kind: "session.event.v2",
                        events: [
                            {
                                eventId: "long-first-completed",
                                position: "3",
                                recordedAt: "2026-09-18T00:00:02.000Z",
                                sessionGenerationId: "session-generation-1",
                                target: nativeTarget(sessionId),
                                type: "lifecycle-metadata",
                                payload: {
                                    commandId: "long-first-turn",
                                    kind: "prompt.completed",
                                    stopReason: "cancelled",
                                },
                            },
                        ],
                    },
                    encryption.computer,
                    signal,
                ),
            );
            daemon.send(
                await sessionTurnStoppedEventCodec.encode(
                    {
                        commandId: "long-first-turn",
                        kind: "session.turn.stopped",
                        requestId: cancellation.requestId,
                        target: nativeTarget(sessionId),
                        stopReason: "cancelled",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const stopped = await responseJson(await cancelTurn, 200);
            expect(
                await sessionTurnStoppedEventCodec.decode(JSON.stringify(stopped), encryption.client, signal),
            ).toMatchObject({ stopReason: "cancelled", commandId: "long-first-turn" });

            // An appended Turn the Computer queues is answered as queued.
            const queuedTurn = submitTurn("queued-follow-up", "queue this follow-up", []);
            expect(
                (await decodeEncryptedDaemonInboundMessage(await daemonMessages.next(), encryption.computer, signal))
                    .kind,
            ).toBe("session.prompt");
            daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "queued-follow-up",
                        target: nativeTarget(sessionId),
                        state: "queued",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const queued = await responseJson(await queuedTurn, 200);
            expect(
                await sessionPromptAcceptedEventCodec.decode(JSON.stringify(queued), encryption.client, signal),
            ).toMatchObject({ state: "queued", requestId: "queued-follow-up" });

            await expect(submitTurn("invalid-image-turn", "describe this", [{ kind: "image" }])).rejects.toMatchObject({
                code: "invalid_protocol_message",
            });
            await expect(submitTurn("oversized-turn", "x".repeat(100_001), [])).rejects.toMatchObject({
                code: "invalid_protocol_message",
            });
            expect(
                await responseJson(
                    await sessionRequest(
                        new Request(
                            `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns`,
                            {
                                body: JSON.stringify({
                                    content: "describe this",
                                    disposition: "append",
                                    idempotencyKey: "invalid-runtime-turn",
                                    attachments: [{ kind: "image" }],
                                    sessionConfigurations: [],
                                }),
                                headers: credentialHeaders(sessionAccess.credential),
                                method: "POST",
                            },
                        ),
                    ),
                    400,
                ),
            ).toMatchObject({ error: { code: "invalid_request" } });
            // A malformed settings change is the caller's error on the Session surface too.
            expect(
                await responseJson(
                    await sessionRequest(
                        new Request(
                            `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/configuration`,
                            {
                                body: JSON.stringify({ configId: "model", type: "select", value: "gpt" }),
                                headers: credentialHeaders(text(sessionAccess, "credential")),
                                method: "POST",
                            },
                        ),
                    ),
                    400,
                ),
            ).toMatchObject({ error: { code: "invalid_request" } });
        } finally {
            daemon.close();
        }
    });

    it("Given an Agent whose capability advertisement withholds steering and Session renaming, When Chat steers a Turn or renames the Session, Then the Relay forwards both and the Computer's own answer decides", async () => {
        const gatedAgent = readyAgents[0];
        if (gatedAgent === undefined) {
            throw new Error("Expected the shared Agent directory entry");
        }
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration());
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const backend = computerBackend(computerId);
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "capability-gated-commands-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const claimed = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${text(pairing, "computerId")}/pairing/redeem`,
                    {
                        body: JSON.stringify({
                            agents: [
                                {
                                    ...gatedAgent,
                                    // The Agent withholds both command capabilities, so pairing
                                    // must still succeed and only the commands are rejected.
                                    capabilities: {
                                        ...gatedAgent.capabilities,
                                        renameSession: false,
                                        steering: false,
                                    },
                                },
                            ],
                            computerName: "Capability-gated commands Computer",
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: "capability-gated-commands-workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
                environment,
            ),
            200,
        );
        const sessionId = "capability-gated-session";
        const sessionAccess = await issueSession(computerId, nativeTarget(sessionId));
        const sessionCredential = text(sessionAccess, "credential");

        // Pairing succeeded, so the Agent remains listed with its capabilities.
        expect(await backend.agents(AbortSignal.timeout(10000))).toMatchObject({
            agents: [{ harness: "codex", label: "Codex" }],
            computerId,
        });

        // The Relay no longer decides from the catalog. It forwards the steer
        // to the Computer, whose own rejection answers with the same
        // machine-readable code and a terminal status.
        const daemonCredential = new DaemonCredential(text(claimed, "computerCredential"));
        const daemonResponse = await daemonCredential.connect((request) => worker.fetch(request, environment));
        if (daemonResponse.webSocket === null) {
            throw new Error("Expected the Computer socket");
        }
        const daemon = daemonResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        daemon.accept();
        try {
            expect(decodeWorkerToDaemonMessage(await daemonMessages.next()).kind).toBe("computer.liveness.ready");
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(computerId, signal);
            const steerCommand = await sessionPromptDispositionCommandCodec.encode(
                {
                    kind: "session.prompt.disposition",
                    requestId: "steer-capability",
                    commandId: "some-active-turn",
                    target: nativeTarget(sessionId),
                    disposition: "steer",
                },
                encryption.client,
                signal,
            );
            const steer = requestBrowserOperation(
                (operation) => worker.fetch(operation, environment),
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/turns/some-active-turn/disposition`,
                    {
                        body: steerCommand,
                        headers: credentialHeaders(sessionCredential),
                        method: "PUT",
                    },
                ),
            );
            const forwarded = await decodeEncryptedDaemonInboundMessage(
                await daemonMessages.next(),
                encryption.computer,
                signal,
            );
            expect(forwarded).toMatchObject({ kind: "session.prompt.disposition", target: nativeTarget(sessionId) });
            if (forwarded.kind !== "session.prompt.disposition") {
                throw new Error("Expected the steer to reach the Computer");
            }
            daemon.send(
                await sessionOperationFailedEventCodec.encode(
                    {
                        code: "steering_unsupported",
                        kind: "session.operation.failed",
                        message: "The selected agent does not support mid-turn steering",
                        requestId: forwarded.requestId,
                        target: nativeTarget(sessionId),
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const steerReply = await responseJson(await steer, 200);
            expect(
                await sessionOperationFailedEventCodec.decode(JSON.stringify(steerReply), encryption.client, signal),
            ).toMatchObject({ code: "steering_unsupported" });

            // A rename forwards unchanged even though no listed Agent
            // advertises renaming: the Computer renames the stored Session
            // itself, exactly as it does for Agents without the extension.
            const renameEncoded = await sessionRenameCommandCodec.encode(
                {
                    kind: "session.rename",
                    requestId: "rename-capability",
                    target: nativeTarget(sessionId),
                    title: "Renamed despite the withheld capability",
                },
                encryption.client,
                signal,
            );
            const rename = requestBrowserOperation(
                (operation) => worker.fetch(operation, environment),
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/harnesses/codex/sessions/${sessionId}/rename`,
                    {
                        body: renameEncoded,
                        headers: credentialHeaders(sessionCredential),
                        method: "POST",
                    },
                ),
            );
            const renameCommand = await decodeEncryptedDaemonInboundMessage(
                await daemonMessages.next(),
                encryption.computer,
                signal,
            );
            expect(renameCommand).toMatchObject({ kind: "session.rename", target: nativeTarget(sessionId) });
            daemon.send(
                await sessionRenamedEventCodec.encode(
                    {
                        kind: "session.renamed",
                        requestId: renameCommand.kind === "session.rename" ? renameCommand.requestId : "",
                        target: nativeTarget(sessionId),
                        title: "Renamed despite the withheld capability",
                        updatedAt: "2030-01-01T00:00:00.000Z",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const renamed = await responseJson(await rename, 200);
            expect(
                await sessionRenamedEventCodec.decode(JSON.stringify(renamed), encryption.client, signal),
            ).toMatchObject({
                kind: "session.renamed",
                target: nativeTarget(sessionId),
                title: "Renamed despite the withheld capability",
            });
        } finally {
            daemon.close(1000, "Test complete");
        }
    });

    it("Given an Agent advertisement carrying fields and capability values the Relay cannot interpret, When it pairs, Then pairing rejects the invalid capabilities", async () => {
        const worker = createTestMortyRelayApp(new RelayAuthenticationConfiguration());
        const environment = bindings();
        const owner = await createOwner();
        const { computerId } = owner;
        const appCredential = owner.token;
        const pairing = await responseJson(
            await ownerRequest(
                new Request(`${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${computerId}/pairing`, {
                    body: JSON.stringify({ idempotencyKey: "malformed-capabilities-runtime" }),
                    headers: credentialHeaders(appCredential),
                    method: "POST",
                }),
            ),
            201,
        );
        const advertised = readyAgents[0];
        if (advertised === undefined) {
            throw new Error("Expected the shared Agent directory entry");
        }
        const malformed = {
            ...advertised,
            capabilities: {
                ...advertised.capabilities,
                renameSession: "yes",
                steering: null,
            },
        };
        const rejected = await responseJson(
            await worker.fetch(
                new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${text(pairing, "computerId")}/pairing/redeem`,
                    {
                        body: JSON.stringify({
                            agents: [malformed],
                            computerName: "Malformed capabilities Computer",
                            pairingCode: text(pairing, "pairingCode"),
                            workspaceName: "malformed-capabilities-workspace",
                        }),
                        headers: { "content-type": "application/json" },
                        method: "POST",
                    },
                ),
                environment,
            ),
            400,
        );
        expect(rejected).toMatchObject({ error: { code: "invalid_agents" } });
    });

    it("Given a daemon that heartbeats and then falls silent, When Chat submits Turns, Then they reach it while it heartbeats and are refused as computer_offline once the silence outlasts the heartbeat deadline", async () => {
        const runtime = await connectComputerDaemon("silent-daemon", { anchorClockToHeartbeat: true });
        // The clock now reads when Cloudflare answered the daemon's heartbeat.
        const heartbeatAt = Date.now();
        try {
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(runtime.computerId, signal);
            const submit = async (commandId: string) => {
                const encoded = await sessionPromptCommandCodec.encode(
                    {
                        kind: "session.prompt",
                        requestId: commandId,
                        commandId,
                        target: runtime.sessionTarget,
                        prompt: "Direct execution",
                        attachments: [],
                        disposition: "append",
                    },
                    encryption.client,
                    signal,
                );
                const request = new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/turns`,
                    { method: "POST", headers: credentialHeaders(runtime.credential), body: encoded, signal },
                );
                return await requestBrowserOperation((input) => ownerRequest(input), request);
            };
            vi.setSystemTime(heartbeatAt + 20_000);
            const delivered = submit("heartbeating-turn");
            expect(
                await decodeEncryptedDaemonInboundMessage(
                    await runtime.daemonMessages.next(),
                    encryption.computer,
                    signal,
                ),
            ).toMatchObject({
                commandId: "heartbeating-turn",
                requestId: "heartbeating-turn",
                kind: "session.prompt",
            });
            runtime.daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "heartbeating-turn",
                        target: runtime.sessionTarget,
                        state: "running",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const routed = await responseJson(await delivered, 200);
            expect(
                await sessionPromptAcceptedEventCodec.decode(JSON.stringify(routed), encryption.client, signal),
            ).toMatchObject({ requestId: "heartbeating-turn", state: "running" });

            // A Turn sent before the deadline still reaches the connection, which never answers it.
            vi.setSystemTime(heartbeatAt + 30_000);
            const stranded = submit("stranded-turn");
            expect(
                await decodeEncryptedDaemonInboundMessage(
                    await runtime.daemonMessages.next(),
                    encryption.computer,
                    signal,
                ),
            ).toMatchObject({
                commandId: "stranded-turn",
                requestId: "stranded-turn",
                kind: "session.prompt",
            });

            // Once the silence outlasts the deadline, the next Turn is refused at once and releases the stranded one.
            vi.setSystemTime(heartbeatAt + 36_000);
            expect(await responseJson(await submit("after-silence-turn"), 503)).toMatchObject({
                error: { code: "computer_offline" },
            });
            expect(await responseJson(await stranded, 503)).toMatchObject({ error: { code: "computer_offline" } });
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Computer heartbeat timed out" });
        } finally {
            // Cloudflare's clock has not reached the times set above, and the run does not finish
            // tearing down while the test clock is still ahead of it.
            vi.setSystemTime(heartbeatAt);
            runtime.daemon.close();
        }
    });

    it.each([
        { kind: "permission", responderId: "member-1", outcome: "selected", optionId: "allow_once" },
        { kind: "elicitation", responderId: "member-1", action: "accept", content: '{"answer":"continue"}' },
    ] as const)(
        "Given a daemon whose heartbeats stopped, When an app answers a pending $kind request, Then the answer is refused at once as computer_offline",
        async (body) => {
            const runtime = await connectComputerDaemon(`offline-${body.kind}-answer`, {
                anchorClockToHeartbeat: true,
            });
            // The clock now reads when Cloudflare answered the daemon's heartbeat.
            const heartbeatAt = Date.now();
            try {
                vi.setSystemTime(heartbeatAt + 36_000);
                const signal = new AbortController().signal;
                const encryption = await endpointEncryption(runtime.computerId, signal);
                const encoded =
                    body.kind === "permission"
                        ? await sessionPermissionRespondCommandCodec.encode(
                              {
                                  kind: "session.permission.respond",
                                  requestId: "offline-answer",
                                  interactionId: "offline-interaction",
                                  target: runtime.sessionTarget,
                                  outcome: body.outcome,
                                  optionId: body.optionId,
                              },
                              encryption.client,
                              signal,
                          )
                        : await sessionElicitationRespondCommandCodec.encode(
                              {
                                  kind: "session.elicitation.respond",
                                  requestId: "offline-answer",
                                  interactionId: "offline-interaction",
                                  target: runtime.sessionTarget,
                                  action: body.action,
                                  content: body.content,
                              },
                              encryption.client,
                              signal,
                          );
                const request = new Request(
                    `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/interactions/offline-interaction/responses`,
                    { method: "POST", headers: credentialHeaders(runtime.credential), body: encoded, signal },
                );
                const answer = await requestBrowserOperation((input) => ownerRequest(input), request);
                expect(await responseJson(answer, 503)).toMatchObject({ error: { code: "computer_offline" } });
                expect(await runtime.daemonClosed).toMatchObject({
                    code: 4001,
                    reason: "Computer heartbeat timed out",
                });
            } finally {
                vi.setSystemTime(heartbeatAt);
                runtime.daemon.close();
            }
        },
    );

    it("Given a daemon whose heartbeats stopped, When an app reads the Computer, Then it is reported offline and its connection is closed", async () => {
        const runtime = await connectComputerDaemon("silent-presence", { anchorClockToHeartbeat: true });
        // The clock now reads when Cloudflare answered the daemon's heartbeat.
        const heartbeatAt = Date.now();
        try {
            vi.setSystemTime(heartbeatAt + 30_000);
            expect(await runtime.readOnline()).toBe(true);

            vi.setSystemTime(heartbeatAt + 36_000);
            expect(await runtime.readOnline()).toBe(false);
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Computer heartbeat timed out" });
        } finally {
            vi.setSystemTime(heartbeatAt);
            runtime.daemon.close();
        }
    });

    it("Given a daemon using fixed-text heartbeats, When it sends a noncanonical heartbeat near its deadline, Then only host auto-responses renew its liveness", async () => {
        const runtime = await connectComputerDaemon("noncanonical-heartbeat", { anchorClockToHeartbeat: true });
        const heartbeatAt = Date.now();
        try {
            vi.setSystemTime(heartbeatAt + 30_000);
            runtime.daemon.send(JSON.stringify({ extra: "ignored", kind: "computer.heartbeat" }));
            expect(await runtime.readOnline()).toBe(true);

            vi.setSystemTime(heartbeatAt + 36_000);
            expect(await runtime.readOnline()).toBe(false);
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Computer heartbeat timed out" });
        } finally {
            vi.setSystemTime(heartbeatAt);
            runtime.daemon.close();
        }
    });

    it("Given a daemon that never heartbeats after it connected, When its first heartbeat is overdue, Then it is reported offline and its connection is closed", async () => {
        const runtime = await connectComputerDaemon("unproven-daemon");
        const connectedAt = Date.now();
        try {
            // The first heartbeat follows attachment, which has 30 seconds, then the usual silence limit applies.
            vi.setSystemTime(connectedAt + 65_000);
            expect(await runtime.readOnline()).toBe(true);

            vi.setSystemTime(connectedAt + 65_001);
            expect(await runtime.readOnline()).toBe(false);
            expect(await runtime.daemonClosed).toMatchObject({ code: 4001, reason: "Computer heartbeat timed out" });
        } finally {
            vi.setSystemTime(connectedAt);
            runtime.daemon.close();
        }
    });
});

function forkResult(requestId: string, target: NativeSessionTarget) {
    return {
        kind: "native.session.result",
        action: "fork",
        requestId,
        target,
        title: "Source (fork 1)",
        ready: {
            kind: "session.ready",
            requestId,
            target,
            harness: "codex",
            agentName: "Codex",
            agentVersion: "1.0.0",
            restored: true,
            directory: ".",
            directoryLabel: "Workspace",
            configurationRevision: "revision-1",
            capabilities: readyAgents[0]?.capabilities,
            commands: [],
            configOptions: [],
        },
    };
}

async function forkRequestId(computerId: string, operationId: string): Promise<string> {
    const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${computerId}\u0000fork\u0000${operationId}`)),
    );
    return `chat_${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

it("Given a Fork in flight, When it is requested again concurrently and after Relay eviction, Then each Computer request carries the operation identity and the Relay keeps no outcome of its own", async () => {
    const runtime = await connectComputerDaemon("fork-operation-identity");
    const input = {
        harness: "codex",
        sessionId: "native-source",
        directory: ".",
    };
    const operationId = "retained-fork-operation";
    try {
        const signal = new AbortController().signal;
        const encryption = await endpointEncryption(runtime.computerId, signal);
        const requestId = await forkRequestId(runtime.computerId, operationId);
        const makeFork = (source: typeof input) =>
            nativeSessionRequestCodec.encode(
                { kind: "native.session.request", action: "fork", requestId, ...source },
                encryption.client,
                signal,
            );
        const encoded = await makeFork(input);
        const first = runtime.forkNative(operationId, encoded);
        // The controlled daemon owns fork allocation; the request never carries a destination.
        const fork = await decodeEncryptedDaemonInboundMessage(
            await runtime.daemonMessages.next(),
            encryption.computer,
            signal,
        );
        expect(fork).toMatchObject({
            kind: "native.session.request",
            action: "fork",
            requestId: expect.any(String),
            sessionId: "native-source",
            directory: ".",
        });
        expect(fork).not.toHaveProperty("targetSessionId");
        expect(await responseJson(await runtime.forkNative(operationId, encoded), 409)).toMatchObject({
            error: { code: "session_busy" },
        });
        const different = await makeFork({ ...input, sessionId: "another-source" });
        expect(await responseJson(await runtime.forkNative(operationId, different), 409)).toMatchObject({
            error: { code: "session_busy" },
        });
        const forkTarget = nativeTarget("harness-fork-destination");
        runtime.daemon.send(
            await nativeSessionResultCodec.encode(forkResult(requestId, forkTarget), encryption.computer, signal),
        );

        const original = await responseJson(await first, 200);

        expect(
            await nativeSessionResultCodec.decode(JSON.stringify(original), encryption.client, signal),
        ).toMatchObject({ action: "fork", target: forkTarget });

        await evictDurableObject(env.COMPUTER_RELAY.getByName(computerObjectName(runtime.computerId)), {
            webSockets: "hibernate",
        });
        const replayed = runtime.forkNative(operationId, await makeFork(input));
        // The Computer answers the retry from the receipt it keeps under the same operation identity.
        expect(
            await decodeEncryptedDaemonInboundMessage(await runtime.daemonMessages.next(), encryption.computer, signal),
        ).toEqual(fork);
        runtime.daemon.send(
            await nativeSessionResultCodec.encode(forkResult(requestId, forkTarget), encryption.computer, signal),
        );
        const replayedRouting = await responseJson(await replayed, 200);
        expect(
            await nativeSessionResultCodec.decode(JSON.stringify(replayedRouting), encryption.client, signal),
        ).toMatchObject({ action: "fork", target: forkTarget });
    } finally {
        runtime.daemon.close(1000, "Fork recovery scenario completed");
    }
});

it("Given the Computer rejects a Fork, When the same operation is retried, Then the rejection is reported and the retry forks again", async () => {
    const runtime = await connectComputerDaemon("fork-rejected");
    const input = {
        harness: "codex",
        sessionId: "native-source",
        directory: ".",
    };
    const operationId = "rejected-fork-operation";
    try {
        const signal = new AbortController().signal;
        const encryption = await endpointEncryption(runtime.computerId, signal);
        const requestId = await forkRequestId(runtime.computerId, operationId);
        const makeFork = () =>
            nativeSessionRequestCodec.encode(
                { kind: "native.session.request", action: "fork", requestId, ...input },
                encryption.client,
                signal,
            );
        const forkCommand = async () => {
            const fork = await decodeEncryptedDaemonInboundMessage(
                await runtime.daemonMessages.next(),
                encryption.computer,
                signal,
            );
            expect(fork).toMatchObject({ kind: "native.session.request", action: "fork", sessionId: "native-source" });
            if (fork.kind !== "native.session.request" || fork.action !== "fork") {
                throw new Error("Expected the native fork request");
            }
            return fork;
        };
        const first = runtime.forkNative(operationId, await makeFork());
        const rejected = await forkCommand();
        runtime.daemon.send(
            await sessionOperationFailedEventCodec.encode(
                {
                    kind: "session.operation.failed",
                    code: "native_session_unsupported",
                    message: "This Agent does not support session forking",
                    requestId,
                },
                encryption.computer,
                signal,
            ),
        );
        const rejectedRouting = await responseJson(await first, 200);
        expect(
            await sessionOperationFailedEventCodec.decode(JSON.stringify(rejectedRouting), encryption.client, signal),
        ).toMatchObject({ code: "native_session_unsupported" });

        const retried = runtime.forkNative(operationId, await makeFork());
        const fork = await forkCommand();
        expect(fork.requestId).toBe(rejected.requestId);
        expect(fork).not.toHaveProperty("targetSessionId");
        const forkTarget = nativeTarget("harness-fork-after-refusal");
        runtime.daemon.send(
            await nativeSessionResultCodec.encode(forkResult(requestId, forkTarget), encryption.computer, signal),
        );
        const forked = await responseJson(await retried, 200);
        expect(await nativeSessionResultCodec.decode(JSON.stringify(forked), encryption.client, signal)).toMatchObject({
            action: "fork",
            target: forkTarget,
        });
    } finally {
        runtime.daemon.close(1000, "Fork rejection scenario completed");
    }
});

it("Given an anonymous browser knows a Computer, When it declares a full-budget upload, Then it is rejected and an authorized browser can still upload", async () => {
    const runtime = await connectComputerDaemon("upload-admission");
    const anonymous = (await runtime.transport()).webSocket;
    const browser = (await runtime.transport()).webSocket;
    if (anonymous === null || browser === null) {
        throw new Error("Expected browser transports");
    }
    const anonymousMessages = new SocketMessages(anonymous);
    const browserMessages = new SocketMessages(browser);
    anonymous.accept();
    browser.accept();
    const path =
        MORTY_API_PREFIX +
        "/v1/computers/" +
        runtime.computerId +
        "/harnesses/" +
        runtime.sessionTarget.harness +
        "/sessions/" +
        runtime.sessionTarget.sessionId +
        "/content/" +
        "a".repeat(64);
    // Alter the first character of the 43-character signature. Its last character carries two
    // padding bits that decoding ignores, so editing that one can leave the signature valid.
    const signatureStart = runtime.credential.length - 43;
    const forgedCredential =
        runtime.credential.slice(0, signatureStart) +
        (runtime.credential[signatureStart] === "A" ? "B" : "A") +
        runtime.credential.slice(signatureStart + 1);
    const declaration = {
        kind: "http.request",
        requestId: "unauthorized",
        method: "PUT",
        path,
        body: "",
        bodyByteLength: 12_582_912,
        headers: [["authorization", `Bearer ${forgedCredential}`]],
    };
    try {
        anonymous.send(JSON.stringify({ ...declaration, headers: [], requestId: "missing-credential" }));
        expect(JSON.parse(await anonymousMessages.next())).toMatchObject({
            kind: "http.error",
            code: "invalid_target",
            requestId: "missing-credential",
            status: 400,
        });
        anonymous.send(JSON.stringify(declaration));
        expect(JSON.parse(await anonymousMessages.next())).toMatchObject({
            kind: "http.response",
            requestId: "unauthorized",
            status: 401,
        });
        const signal = new AbortController().signal;
        const encryption = await endpointEncryption(runtime.computerId, signal);
        const requestId = "authorized-content";
        const write = await contentWriteCommandCodec.encode(
            {
                kind: "content.write",
                requestId,
                target: runtime.sessionTarget,
                contentKey: "a".repeat(64),
                byteLength: 1,
                contentKind: "resource",
                mediaType: "text/plain",
                name: "test.txt",
            },
            encryption.client,
            signal,
        );
        const chunk = await contentChunkCodec.encode(
            { requestId, sequence: 0, bytes: new Uint8Array([120]) },
            encryption.client,
            signal,
        );
        const commit = await contentCommitCommandCodec.encode(
            { kind: "content.commit", requestId, target: runtime.sessionTarget },
            encryption.client,
            signal,
        );
        const records = [
            encodeFileStreamRecord({ kind: "message", encoded: write }),
            encodeFileStreamRecord({ kind: "chunk", encoded: chunk }),
            encodeFileStreamRecord({ kind: "message", encoded: commit }),
        ];
        const wire = new Uint8Array(records.reduce((sum, value) => sum + value.byteLength, 0));
        let offset = 0;
        for (const item of records) {
            wire.set(item, offset);
            offset += item.byteLength;
        }
        browser.send(
            JSON.stringify({
                ...declaration,
                requestId: "authorized",
                bodyByteLength: wire.byteLength,
                headers: [
                    ["authorization", `Bearer ${runtime.credential}`],
                    ["content-type", FILE_STREAM_CONTENT_TYPE],
                ],
                path,
            }),
        );
        browser.send(encodeContentChunkFrame({ requestId: "authorized", sequence: 0, bytes: wire }));
        const command = await decodeEncryptedDaemonInboundMessage(
            await runtime.daemonMessages.next(),
            encryption.computer,
            signal,
        );
        expect(command.kind).toBe("content.write");
        if (command.kind !== "content.write") {
            throw new Error("Expected authorized upload");
        }
        runtime.daemon.send(
            await contentReadyEventCodec.encode(
                {
                    kind: "content.ready",
                    requestId: command.requestId,
                    target: runtime.sessionTarget,
                },
                encryption.computer,
                signal,
            ),
        );
        const frame = await runtime.daemonMessages.nextFrame();
        const arrayBuffer = typeof frame === "object" && frame !== null ? Reflect.get(frame, "arrayBuffer") : undefined;
        const binary = typeof arrayBuffer === "function" ? await Reflect.apply(arrayBuffer, frame, []) : frame;
        expect((await contentChunkCodec.decode(binary, encryption.computer, signal)).bytes).toEqual(
            new Uint8Array([120]),
        );
        expect(
            await decodeEncryptedDaemonInboundMessage(await runtime.daemonMessages.next(), encryption.computer, signal),
        ).toMatchObject({
            kind: "content.commit",
            requestId: command.requestId,
        });
        runtime.daemon.send(
            await contentAvailableEventCodec.encode(
                {
                    kind: "content.available",
                    requestId: command.requestId,
                    target: runtime.sessionTarget,
                    contentKey: "a".repeat(64),
                    byteLength: 1,
                },
                encryption.computer,
                signal,
            ),
        );
        expect(JSON.parse(await browserMessages.next())).toMatchObject({ kind: "http.response", status: 200 });
    } finally {
        anonymous.close();
        browser.close();
        runtime.daemon.close();
    }
});

describe("Computer prompt acknowledgements", () => {
    const sessionClient = async (runtime: Awaited<ReturnType<typeof connectComputerDaemon>>, signal: AbortSignal) => {
        const encryption = await endpointEncryption(runtime.computerId, signal);
        const client = sessionEndpointClient(runtime.computerId, runtime.credential, encryption.access);
        return { client, encryption };
    };
    const lifecycleFrame = (
        sessionTarget: NativeSessionTarget,
        eventId: string,
        position: string,
        payload: Record<string, unknown>,
    ) =>
        JSON.stringify({
            kind: "session.event.v2",
            events: [
                {
                    eventId,
                    position,
                    recordedAt: new Date().toISOString(),
                    sessionGenerationId: "session-generation-1",
                    target: sessionTarget,
                    type: "lifecycle-metadata",
                    payload,
                },
            ],
        });

    it("Given pending submissions, When the Computer answers another request, Then only the reply naming each submission answers it", async () => {
        const runtime = await connectComputerDaemon("named-queue-change");
        try {
            const credential = await runtime.issueComputerCredential(runtime.computerId);
            const signal = new AbortController().signal;
            const encryption = await endpointEncryption(runtime.computerId, signal);
            const queue = async (idempotencyKey: string) => {
                const encoded = await sessionPromptCommandCodec.encode(
                    {
                        kind: "session.prompt",
                        requestId: idempotencyKey,
                        commandId: idempotencyKey,
                        target: runtime.sessionTarget,
                        attachments: [],
                        prompt: `queued ${idempotencyKey}`,
                        disposition: "append",
                    },
                    encryption.client,
                    signal,
                );
                return await requestBrowserOperation(
                    (request) => env.COMPUTER_RELAY.getByName(computerObjectName(runtime.computerId)).fetch(request),
                    new Request(
                        `${relayOrigin}${MORTY_API_PREFIX}/v1/computers/${runtime.computerId}/harnesses/${runtime.sessionTarget.harness}/sessions/${runtime.sessionTarget.sessionId}/turns`,
                        {
                            method: "POST",
                            headers: credentialHeaders(credential),
                            body: encoded,
                        },
                    ),
                );
            };

            const rejected = queue("rejected-command");
            expect(
                await decodeEncryptedDaemonInboundMessage(
                    await runtime.daemonMessages.next(),
                    encryption.computer,
                    signal,
                ),
            ).toMatchObject({
                commandId: "rejected-command",
            });
            // Another request's answer, or this command's own lifecycle, does not answer this submission; the
            // Computer's reply naming it does.
            runtime.daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "other-command",
                        target: runtime.sessionTarget,
                        state: "queued",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            runtime.daemon.send(
                await sessionEventEnvelopeCodec.encode(
                    JSON.parse(
                        lifecycleFrame(runtime.sessionTarget, "rejected-failed", "1", {
                            code: "agent_unavailable",
                            commandId: "rejected-command",
                            kind: "prompt.failed-before-start",
                            message: "The Agent is unavailable",
                        }),
                    ),
                    encryption.computer,
                    signal,
                ),
            );
            runtime.daemon.send(
                await sessionOperationFailedEventCodec.encode(
                    {
                        code: "agent_unavailable",
                        kind: "session.operation.failed",
                        message: "The Agent is unavailable",
                        requestId: "rejected-command",
                        target: runtime.sessionTarget,
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const failure = await rejected;
            expect(failure.status).toBe(200);
            const failedRouting: unknown = await failure.json();
            expect(
                await sessionOperationFailedEventCodec.decode(JSON.stringify(failedRouting), encryption.client, signal),
            ).toMatchObject({ code: "agent_unavailable" });

            const admitted = queue("admitted-command");
            expect(
                await decodeEncryptedDaemonInboundMessage(
                    await runtime.daemonMessages.next(),
                    encryption.computer,
                    signal,
                ),
            ).toMatchObject({
                commandId: "admitted-command",
            });
            runtime.daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "admitted-command",
                        target: runtime.sessionTarget,
                        state: "queued",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            const admittedRouting = await responseJson(await admitted, 200);
            expect(
                await sessionPromptAcceptedEventCodec.decode(
                    JSON.stringify(admittedRouting),
                    encryption.client,
                    signal,
                ),
            ).toMatchObject({ state: "queued", requestId: "admitted-command" });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    }, 30_000);

    it("Given a completed prompt, When it is retried with the same command identifier, Then the Computer's acceptance answers the retry", async () => {
        const runtime = await connectComputerDaemon("retried-prompt");
        try {
            const signal = new AbortController().signal;
            const { client, encryption } = await sessionClient(runtime, signal);
            const submit = () =>
                client.turns.submit(
                    runtime.sessionTarget,
                    { idempotencyKey: "retried-command", content: "Direct execution", attachments: [] },
                    signal,
                );
            const first = submit();
            expect(
                await decodeEncryptedDaemonInboundMessage(
                    await runtime.daemonMessages.next(),
                    encryption.computer,
                    signal,
                ),
            ).toMatchObject({
                commandId: "retried-command",
                requestId: "retried-command",
                kind: "session.prompt",
            });
            runtime.daemon.send(
                await sessionEventEnvelopeCodec.encode(
                    JSON.parse(
                        lifecycleFrame(runtime.sessionTarget, "retried-started", "1", {
                            commandId: "retried-command",
                            attemptId: "retried-attempt",
                            epoch: "retried-epoch",
                            kind: "prompt.started",
                        }),
                    ),
                    encryption.computer,
                    signal,
                ),
            );
            runtime.daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "retried-command",
                        target: runtime.sessionTarget,
                        state: "running",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            expect((await first).turnId).toBe("retried-command");
            runtime.daemon.send(
                await sessionEventEnvelopeCodec.encode(
                    JSON.parse(
                        lifecycleFrame(runtime.sessionTarget, "retried-completed", "2", {
                            commandId: "retried-command",
                            kind: "prompt.completed",
                            stopReason: "end_turn",
                        }),
                    ),
                    encryption.computer,
                    signal,
                ),
            );

            const retry = submit();
            expect(
                await decodeEncryptedDaemonInboundMessage(
                    await runtime.daemonMessages.next(),
                    encryption.computer,
                    signal,
                ),
            ).toMatchObject({
                commandId: "retried-command",
                requestId: "retried-command",
                kind: "session.prompt",
            });
            runtime.daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "retried-command",
                        target: runtime.sessionTarget,
                        state: "settled",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            expect(await retry).toMatchObject({ turnId: "retried-command" });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    }, 30_000);

    it("Given a prompt that already settled, When it is retried with the same idempotency key, Then the Turn is reported indeterminate instead of running", async () => {
        const runtime = await connectComputerDaemon("settled-retry");
        try {
            const signal = new AbortController().signal;
            const { client, encryption } = await sessionClient(runtime, signal);
            const retry = client.turns.submit(
                runtime.sessionTarget,
                { idempotencyKey: "settled-command", content: "Direct execution", attachments: [] },
                signal,
            );
            expect(
                await decodeEncryptedDaemonInboundMessage(
                    await runtime.daemonMessages.next(),
                    encryption.computer,
                    signal,
                ),
            ).toMatchObject({
                commandId: "settled-command",
                requestId: "settled-command",
                kind: "session.prompt",
            });
            runtime.daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "settled-command",
                        target: runtime.sessionTarget,
                        state: "settled",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            expect(await retry).toMatchObject({
                state: {
                    kind: "indeterminate",
                    reconciliation: { detectedAt: "2026-09-18T00:00:00.000Z", reason: "dispatch_indeterminate" },
                },
                turnId: "settled-command",
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    }, 30_000);
    it("Given a submitted prompt whose Agent is still starting, When the Turn is cancelled before it starts, Then the submission is answered by that outcome instead of waiting for its deadline", async () => {
        const runtime = await connectComputerDaemon("cancelled-before-start");
        try {
            const signal = new AbortController().signal;
            const { client, encryption } = await sessionClient(runtime, signal);
            const submission = client.turns.submit(
                runtime.sessionTarget,
                { idempotencyKey: "preparing-command", content: "Direct execution", attachments: [] },
                signal,
            );
            expect(
                await decodeEncryptedDaemonInboundMessage(
                    await runtime.daemonMessages.next(),
                    encryption.computer,
                    signal,
                ),
            ).toMatchObject({
                commandId: "preparing-command",
                requestId: "preparing-command",
                kind: "session.prompt",
            });
            const cancel = client.turns.cancel(runtime.sessionTarget, "preparing-command", signal);
            const cancellation = await decodeEncryptedDaemonInboundMessage(
                await runtime.daemonMessages.next(),
                encryption.computer,
                signal,
            );
            if (cancellation.kind !== "session.cancel") {
                throw new Error("Expected the cancellation to reach the Computer");
            }
            expect(cancellation.commandId).toBe("preparing-command");
            // A command cancelled before it starts answers its submission as settled, and the cancellation with
            // how it stopped.
            runtime.daemon.send(
                await sessionPromptAcceptedEventCodec.encode(
                    {
                        kind: "session.prompt.accepted",
                        requestId: "preparing-command",
                        target: runtime.sessionTarget,
                        state: "settled",
                    },
                    encryption.computer,
                    signal,
                ),
            );
            runtime.daemon.send(
                await sessionTurnStoppedEventCodec.encode(
                    {
                        commandId: "preparing-command",
                        kind: "session.turn.stopped",
                        requestId: cancellation.requestId,
                        target: runtime.sessionTarget,
                        stopReason: "cancelled",
                    },
                    encryption.computer,
                    signal,
                ),
            );

            expect(await cancel).toMatchObject({ stopReason: "cancelled" });
            expect(await submission).toMatchObject({
                state: { kind: "indeterminate", reconciliation: { reason: "dispatch_indeterminate" } },
                turnId: "preparing-command",
            });
        } finally {
            runtime.daemon.close(1000, "Test complete");
        }
    }, 30_000);
});
