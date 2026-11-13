import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    type AcpSessionUpdate,
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    COMPUTER_LIVENESS_READY_KIND,
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionReadyEvent,
    encodeComputerLivenessReadyEvent,
    encodeSessionCreateCommand,
    encodeSessionPromptCommand,
    MORTY_API_PREFIX,
    SESSION_EVENT_KIND,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { createRuntimeConfig, RuntimeAgentDependencies, RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { testAgentDefinition } from "../support/agent-definition.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

class Messages {
    readonly #closed = Promise.withResolvers<never>();
    readonly #buffered: string[] = [];
    readonly #waiting: Array<(message: string) => void> = [];

    constructor(socket: WebSocket) {
        void this.#closed.promise.catch(() => {});
        socket.once("close", () => this.#closed.reject(new Error("The daemon disconnected during the request")));
        socket.on("message", (value) => {
            const message = value.toString();
            // Like the Relay's host, answer exactly the heartbeat text without the application.
            if (message === COMPUTER_HEARTBEAT_MESSAGE) {
                socket.send(COMPUTER_HEARTBEAT_ACK_MESSAGE);
                return;
            }
            const resolve = this.#waiting.shift();
            if (resolve === undefined) {
                this.#buffered.push(message);
            } else {
                resolve(message);
            }
        });
        socket.send(encodeComputerLivenessReadyEvent({ kind: COMPUTER_LIVENESS_READY_KIND }));
    }

    readonly next = (): Promise<string> => {
        const buffered = this.#buffered.shift();
        return Promise.race([
            this.#closed.promise,
            buffered === undefined
                ? new Promise<string>((resolve) => this.#waiting.push(resolve))
                : Promise.resolve(buffered),
        ]);
    };
}

test("Given real Codex dispatches and waits for a subagent, When the turn runs through the daemon, Then ACP exposes both collaboration calls", async () => {
    const prompt = "Dispatch a subagent, wait for it, then report completion.";
    const childPrompt = "Reply exactly: child complete.";
    const provider = await FakeOpenAiProvider.start("morty-test-model", "Parent complete", {
        toolPrompt: prompt,
        toolSequence: [
            {
                name: "spawn_agent",
                input: JSON.stringify({ fork_turns: "none", message: childPrompt, task_name: "inventory" }),
            },
            { name: "wait_agent", input: JSON.stringify({ timeout_ms: 3_600_000 }) },
        ],
    });
    const codex = await CodexFixture.create(provider);
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-real-codex-collaboration-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MORTY_API_PREFIX}/channels/real-codex-collaboration/daemon`,
    );
    const agent = testAgentDefinition("codex", "Codex", codex.executable, codex.environment);
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "real-codex-collaboration",
            defaultWorkspace: workspace,
            relayUrl,
        },
        new RuntimeAgentDependencies([agent]),
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);

    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        const requestId = randomUUID();
        socket.send(
            encodeSessionCreateCommand({
                kind: "session.create",
                requestId,
                operationId: randomUUID(),
                harness: "codex",
                directory: ".",
                configurations: [],
            }),
        );
        let created = await messages.next();
        while (decodeMessageKind(created) !== "session.ready") {
            if (decodeMessageKind(created) === "session.operation.failed") {
                throw new Error(created);
            }
            created = await messages.next();
        }
        const sessionTarget = decodeSessionReadyEvent(created).target;
        const commandId = randomUUID();
        socket.send(
            encodeSessionPromptCommand({
                requestId: commandId,
                commandId,
                requestId: commandId,
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt,
                target: sessionTarget,
            }),
        );

        const updates: AcpSessionUpdate[] = [];
        let completed = false;
        while (!completed) {
            const message = await messages.next();
            if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                continue;
            }
            for (const event of decodeSessionEventEnvelope(message).events) {
                if (event.type === "acp") {
                    updates.push(event.payload);
                }
                if (
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.completed" &&
                    event.payload.commandId === commandId
                ) {
                    completed = true;
                }
                if (
                    event.type === "lifecycle-metadata" &&
                    (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                ) {
                    throw new Error(`Real Codex collaboration turn failed: ${JSON.stringify(event)}`);
                }
            }
        }

        const completedTools = updates.filter(
            (update) => update.sessionUpdate === "tool_call_update" && update.status === "completed",
        );
        expect(completedTools, JSON.stringify(provider.diagnostics(), null, 2)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: "other",
                    name: "spawn_agent",
                    rawInput: { agentPath: "/root/inventory" },
                    rawOutput: expect.objectContaining({ agentThreadId: expect.any(String) }),
                    status: "completed",
                    title: "Dispatch subagent /root/inventory",
                }),
                expect.objectContaining({
                    kind: "other",
                    name: "wait_agent",
                    status: "completed",
                    title: "Wait for subagent",
                }),
            ]),
        );
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { force: true, recursive: true });
        await codex[Symbol.asyncDispose]();
        await provider[Symbol.asyncDispose]();
    }
}, 120_000);
