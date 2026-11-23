import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    encodeNativeSessionCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { stopProcessTree } from "../../src/engine/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given desktop Codex owned the conversation when Morty opened it, When desktop Codex quits and I send a message, Then Codex runs it and I see the reply", async ({
    signal,
}) => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "CLOSED_OWNER_REPLY");
    await using fixture = await CodexFixture.create(provider);
    await withRealDaemon(signal, new CodexAgentSpecification(), fixture.environment, async (peer) => {
        const seeded = Promise.withResolvers<void>();
        const owner = new CodexAppServerClient({
            command: fixture.executable,
            cwd: peer.workspace,
            environment: fixture.environment,
            handlers: {
                onNotification: async (method) => {
                    if (method === "turn/completed") {
                        seeded.resolve();
                    }
                },
                onServerRequest: async () => {},
            },
        });
        let id = "";
        try {
            await owner.initialize(peer.signal);
            const started = await owner.request(
                "thread/start",
                { cwd: peer.workspace, model: "morty-test-model" },
                peer.signal,
            );
            const thread: unknown =
                typeof started === "object" && started !== null ? Reflect.get(started, "thread") : undefined;
            const threadId: unknown =
                typeof thread === "object" && thread !== null ? Reflect.get(thread, "id") : undefined;
            if (typeof threadId !== "string") {
                throw new Error("Missing Codex identity");
            }
            id = threadId;
            await owner.request(
                "turn/start",
                { threadId: id, input: [{ type: "text", text: "Desktop seed", text_elements: [] }] },
                peer.signal,
            );
            await seeded.promise;
            const base = { kind: "native.session.request", harness: "codex", directory: "." } as const;
            peer.send(encodeNativeSessionCommand({ ...base, action: "import", requestId: "open", sessionId: id }));
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "native.session.result") {
                    const result = decodeNativeSessionResult(message);
                    if (result.requestId === "open") {
                        expect(result).toMatchObject({
                            action: "import",
                            ready: { capabilities: { steering: false } },
                        });
                        break;
                    }
                }
            }
        } finally {
            owner.detach();
            await stopProcessTree(owner.child());
        }

        await peer.subscribe({ harness: "codex", sessionId: id });
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                target: { harness: "codex", sessionId: id },
                commandId,
                requestId: commandId,
                prompt: "Sent after the desktop closed",
                attachments: [],
                disposition: SessionPromptDisposition.Append,
            }),
        );
        let reply = "";
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                reply += event.payload.content.text;
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                throw new Error(`The prompt failed: ${event.payload.code}`);
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                expect(event.payload.commandId).toBe(commandId);
                break;
            }
        }
        expect(reply).toContain("CLOSED_OWNER_REPLY");
    });
});
