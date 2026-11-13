import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionReadyEvent,
    encodeSessionCreateCommand,
    encodeSessionPromptCommand,
    MORTY_API_PREFIX,
    SESSION_EVENT_KIND,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../support/controlled-runtime-config.ts";
import { createEncryptedDaemonGateway, type EncryptedDaemonPeer } from "../support/encrypted-daemon-gateway.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

describe("daemon narration delivery", () => {
    it("Given an Agent streams a long reasoning activity, When the turn completes, Then bounded narration increments preserve it without duplicate text", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-narration-delta-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const gateway = await createEncryptedDaemonGateway(stateDirectory, "channel_beta", AbortSignal.timeout(30_000));
        const socketReady = Promise.withResolvers<EncryptedDaemonPeer>();
        const relay = createServer((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        const sockets = new WebSocketServer({ server: relay });
        sockets.on("connection", (socket) => socketReady.resolve(gateway.connect(socket)));
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/channel_beta/daemon`);
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Controlled ACP"],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
            { MORTY_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createRuntimeConfig(
            {
                computerId: "channel_beta",
                defaultWorkspace: workspace,
                relayUrl,
                credentials: memoryComputerCredentials("e".repeat(43)),
            },
            [agent],
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const socket = await socketReady.promise;
            const frames = socket;
            await socket.send(
                encodeSessionCreateCommand({
                    kind: "session.create",
                    requestId: crypto.randomUUID(),
                    operationId: crypto.randomUUID(),
                    harness: agent.harness,
                    directory: ".",
                    configurations: [],
                }),
            );
            let created = await frames.next();
            while (decodeMessageKind(created) !== "session.ready") {
                if (decodeMessageKind(created) === "session.operation.failed") {
                    throw new Error(created);
                }
                created = await frames.next();
            }
            const prompt: SessionPromptCommand = {
                commandId: "narration_turn",
                requestId: "narration_turn",
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "stream verbose activity",
                target: decodeSessionReadyEvent(created).target,
            };
            await socket.send(encodeSessionPromptCommand(prompt));

            let narration = "";
            let completedNarration = false;
            for (;;) {
                const message = await frames.next();
                if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                    continue;
                }
                const events = decodeSessionEventEnvelope(message).events;
                for (const event of events) {
                    if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_thought_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        narration += event.payload.content.text;
                        completedNarration = true;
                    }
                    if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        throw new Error(message);
                    }
                }
                if (
                    events.some(
                        (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
                    )
                ) {
                    break;
                }
            }
            expect(completedNarration).toBe(true);
            expect(narration).toContain("Inspecting the workspace");
            expect(narration.split("step-0")).toHaveLength(2);
            expect(narration.split("step-63")).toHaveLength(2);
        } finally {
            cancellation.abort();
            await runtime;
            await gateway.close();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);
});
