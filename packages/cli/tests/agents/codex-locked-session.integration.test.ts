import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    encodeNativeSessionCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { stopProcessTree } from "../../src/engine/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given desktop Codex owns the Session, When Morty imports it and receives stale steering, Then steering is unsupported and queued input completes without interrupting the owner", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "LOCKED_SESSION_REPLY", {
        beforeFirstText: async () => {
            if (hold) {
                entered.resolve();
                await release.promise;
            }
        },
    });
    await using fixture = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), fixture.environment, async (peer) => {
        let completed = Promise.withResolvers<void>();
        const owner = new CodexAppServerClient({
            command: fixture.executable,
            cwd: peer.workspace,
            environment: fixture.environment,
            handlers: {
                onNotification: async (method) => {
                    if (method === "turn/completed") {
                        completed.resolve();
                    }
                },
                onServerRequest: async () => {},
            },
        });
        try {
            await owner.initialize(peer.signal);
            const started = await owner.request(
                "thread/start",
                { cwd: peer.workspace, model: "morty-test-model" },
                peer.signal,
            );
            const thread: unknown =
                typeof started === "object" && started !== null ? Reflect.get(started, "thread") : undefined;
            const id: unknown = typeof thread === "object" && thread !== null ? Reflect.get(thread, "id") : undefined;
            if (typeof id !== "string") {
                throw new Error("Missing Codex identity");
            }
            const start = async (text: string): Promise<void> => {
                await owner.request(
                    "turn/start",
                    { threadId: id, input: [{ type: "text", text, text_elements: [] }] },
                    peer.signal,
                );
            };
            await start("Local seed");
            await completed.promise;
            const base = {
                kind: "native.session.request",
                harness: "codex",
                directory: ".",
            } as const;
            peer.send(encodeNativeSessionCommand({ ...base, action: "list", requestId: "list", cursor: null }));
            let sessionId = "";
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "native.session.result") {
                    const result = decodeNativeSessionResult(message);
                    if (result.action === "list") {
                        sessionId = result.entries[0]?.sessionId ?? "";
                        break;
                    }
                }
            }
            expect(sessionId).not.toBe("");
            peer.send(
                encodeNativeSessionCommand({
                    ...base,
                    action: "import",
                    requestId: "open",
                    sessionId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "native.session.result") {
                    const result = decodeNativeSessionResult(message);
                    if (result.requestId === "open") {
                        expect(result).toMatchObject({
                            action: "import",
                            ready: {
                                target: { harness: "codex", sessionId: id },
                                capabilities: { steering: false },
                            },
                        });
                        break;
                    }
                }
                if (message.includes('"error"') || message.includes('"failed"')) {
                    throw new Error(message);
                }
            }
            completed = Promise.withResolvers<void>();
            hold = true;
            await start("Local owner is still running");
            await entered.promise;
            const commandId = randomUUID();
            const steeringCommandId = randomUUID();
            let rejectedSteering = false;
            peer.send(
                encodeSessionPromptCommand({
                    ...base,
                    kind: "session.prompt",
                    target: { harness: "codex", sessionId: id },
                    commandId,
                    requestId: commandId,
                    prompt: "Queued from Morty",
                    attachments: [],
                    disposition: SessionPromptDisposition.Append,
                }),
            );
            // The public prompt-started event establishes that the daemon accepted the remote turn.
            let reply = "";
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.started" &&
                    event.payload.commandId === commandId
                ) {
                    peer.send(
                        encodeSessionPromptCommand({
                            ...base,
                            kind: "session.prompt",
                            target: { harness: "codex", sessionId: id },
                            commandId: steeringCommandId,
                            requestId: steeringCommandId,
                            prompt: "A stale client attempts steering",
                            attachments: [],
                            disposition: SessionPromptDisposition.Steer,
                            targetCommandId: commandId,
                        }),
                    );
                }
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    reply += event.payload.content.text;
                }
                if (
                    event.type === "lifecycle-metadata" &&
                    (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                ) {
                    expect(event.payload.commandId).toBe(steeringCommandId);
                    expect(event.payload.code).toBe("steering_unsupported");
                    const running = await owner.request(
                        "thread/read",
                        { threadId: id, includeTurns: true },
                        peer.signal,
                    );
                    expect(running).toMatchObject({
                        thread: { turns: expect.arrayContaining([expect.objectContaining({ status: "inProgress" })]) },
                    });
                    rejectedSteering = true;
                    release.resolve();
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.commandId).toBe(commandId);
                    break;
                }
            }
            expect(rejectedSteering).toBe(true);
            expect(reply).toContain("LOCKED_SESSION_REPLY");
            const history = await owner.request("thread/read", { threadId: id, includeTurns: true }, peer.signal);
            expect(JSON.stringify(history)).toContain("Queued from Morty");
            expect(JSON.stringify(history)).not.toContain("A stale client attempts steering");
        } finally {
            release.resolve();
            owner.detach();
            await stopProcessTree(owner.child());
        }
    });
});
