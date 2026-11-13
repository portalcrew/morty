import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    decodeSessionInteractionAnsweredEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionPromptAcceptedEvent,
    decodeSessionReadyEvent,
    encodeNativeSessionRequest,
    encodeSessionCreateCommand,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    MORTY_API_PREFIX,
    SESSION_EVENT_KIND,
    type SessionLiveEvent,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { ControlledEndpointConnection } from "@morty-build/runtime-test-support/fake-daemon";
import { expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { AgentTermination } from "../../src/engine/acp/agent/agent-lifecycle.ts";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createControlledRuntimeConfig } from "../support/controlled-runtime-config.ts";
import { createEncryptedDaemonFrames } from "../support/encrypted-daemon-frames.ts";

test("Given a completed foreground turn, When its Agent requests background permission, Then the session snapshot recovers that request and removes it after the user responds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-background-interaction-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const server = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    const frames: string[] = [];
    const readers: Array<(frame: string) => void> = [];
    const encryption = await createEncryptedDaemonFrames(directory, "background", AbortSignal.timeout(60_000));
    server.on("connection", (socket) => {
        socket.on("message", (data) => {
            if (data.toString().includes('"kind":"computer.heartbeat"')) {
                socket.send(JSON.stringify({ kind: "computer.heartbeat.ack" }));
                return;
            }
            const reader = readers.shift();
            if (reader === undefined) {
                frames.push(data.toString());
            } else {
                reader(data.toString());
            }
        });
        connected.resolve(socket);
    });
    const next = async () => {
        const frame = frames.shift() ?? (await new Promise<string>((resolve) => readers.push(resolve)));
        const encoded = await encryption.decode(frame);
        if (typeof encoded !== "string") throw new Error("Expected a text daemon response");
        switch (decodeMessageKind(encoded)) {
            case "session.ready":
                return decodeSessionReadyEvent(encoded);
            case "session.operation.failed":
                return decodeSessionOperationFailedEvent(encoded);
            case "session.event.v2":
                return decodeSessionEventEnvelope(encoded);
            case "native.session.result":
                return decodeNativeSessionResult(encoded);
            case "session.interaction.answered":
                return decodeSessionInteractionAnsweredEvent(encoded);
            case "session.prompt.accepted":
                return decodeSessionPromptAcceptedEvent(encoded);
            default:
                throw new Error("Unexpected daemon message");
        }
    };
    const live = async (kind: string): Promise<SessionLiveEvent> => {
        for (;;) {
            const message = await next();
            if (message.kind !== SESSION_EVENT_KIND) {
                continue;
            }
            const event = message.events.find(
                (event) => event.type === "lifecycle-metadata" && event.payload.kind === kind,
            );
            if (event !== undefined) {
                return event;
            }
        }
    };
    let requestPermission: () => Promise<acp.RequestPermissionResponse> = async () => {
        throw new Error("The Agent has not completed a foreground prompt");
    };
    const agent = createControlledAgent(
        (options) => {
            const terminated = Promise.withResolvers<AgentTermination>();
            let connection: acp.AgentConnection | null = null;
            const app = acp
                .agent({ name: "background-interaction" })
                .onConnect((value) => {
                    connection = value;
                })
                .onRequest(acp.methods.agent.initialize, () => ({
                    agentCapabilities: { loadSession: false, sessionCapabilities: { close: {}, resume: {} } },
                    authMethods: [],
                    protocolVersion: acp.PROTOCOL_VERSION,
                }))
                .onRequest(acp.methods.agent.session.new, () => ({ sessionId: crypto.randomUUID() }))
                .onRequest(acp.methods.agent.session.resume, () => ({}))
                .onRequest(acp.methods.agent.session.close, () => ({}))
                .onRequest(acp.methods.agent.session.prompt, (context) => {
                    requestPermission = () =>
                        context.client.request(acp.methods.client.session.requestPermission, {
                            sessionId: context.params.sessionId,
                            options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
                            toolCall: {
                                toolCallId: "background-tool",
                                kind: "execute",
                                title: "Background verification",
                                status: "pending",
                                rawInput: { command: "echo verified" },
                            },
                        });
                    return { stopReason: "end_turn" };
                });
            return new ControlledEndpointConnection(
                {
                    app: () => app,
                    initialize: async (signal) => signal.throwIfAborted(),
                    terminated: terminated.promise,
                    close: async () => {
                        connection?.close();
                        terminated.resolve({ kind: "closed" });
                    },
                },
                options.client,
            );
        },
        "claude",
        "Controlled background Agent",
        process.execPath,
    );
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/background/daemon`);
    const config = createControlledRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "background",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        new RuntimeLocalContext(directory, process.env),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
        const send = async (message: string): Promise<void> => { socket.send(await encryption.encode(message)); };
        const identity = {
            harness: "claude",
            directory: ".",
        };
        await send(
            encodeSessionCreateCommand({
                ...identity,
                kind: "session.create",
                requestId: "prepare",
                operationId: crypto.randomUUID(),
                configurations: [],
            }),
        );
        let created = await next();
        while (created.kind !== "session.ready") {
            if (created.kind === "session.operation.failed") {
                throw new Error(created.message);
            }
            created = await next();
        }
        const sessionTarget = created.target;
        await send(JSON.stringify({ kind: "session.events.subscribe", subscriptionId: "background-subscription", target: sessionTarget }));
        await send(
            encodeSessionPromptCommand({
                requestId: "foreground",
                commandId: "foreground",
                requestId: "foreground",
                target: sessionTarget,
                disposition: "append",
                attachments: [],
                kind: "session.prompt",
                prompt: "Finish before the background approval",
            }),
        );
        await live("prompt.completed");
        const response = requestPermission();
        void response.catch(() => undefined);
        const requested = await live("session.permission.requested");
        if (requested.type !== "lifecycle-metadata" || requested.payload.kind !== "session.permission.requested") {
            throw new Error("Missing permission event");
        }
        expect(requested.payload.event.commandId).toBe("session-control");
        const snapshot = async (requestId: string) => {
            await send(
                encodeNativeSessionRequest({
                    action: "active-turn",
                    kind: "native.session.request",
                    requestId,
                    target: sessionTarget,
                }),
            );
            for (;;) {
                const result = await next();
                if (result.kind === "native.session.result" && result.requestId === requestId) {
                    return result;
                }
            }
        };
        expect(await snapshot("pending")).toMatchObject({
            action: "active-turn",
            turn: null,
            interactionState: {
                sessionGenerationId: requested.sessionGenerationId,
                throughPosition: requested.position,
                interactions: [requested.payload.event],
            },
        });
        await send(
            encodeSessionPermissionRespondCommand({
                target: sessionTarget,
                interactionId: requested.payload.event.interactionId,
                kind: "session.permission.respond",
                requestId: crypto.randomUUID(),
                optionId: "allow-once",
                outcome: "selected",
            }),
        );
        await expect(response).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
        const resolved = await live("session.permission.resolved");
        expect(await snapshot("resolved")).toMatchObject({
            turn: null,
            interactionState: {
                sessionGenerationId: resolved.sessionGenerationId,
                throughPosition: resolved.position,
                interactions: [],
            },
        });
    } finally {
        cancellation.abort();
        await runtime;
        encryption.close();
        for (const socket of server.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
});
