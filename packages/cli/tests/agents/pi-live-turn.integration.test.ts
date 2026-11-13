import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    SESSION_EVENT_KIND,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

test("Given a reused real Pi session, When local commands reply consecutively, Then each reply has a distinct identity without synthetic user chunks", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_LOCAL_COMMAND_REPLY");
    await using agent = await PiFixture.create(provider);
    await agent.overrideSettings({ quietStartup: false });
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const replyIds = new Set<string>();
        for (const prompt of ["Begin", "/session", "/session", "/steering", "/steering", "/export", "/export"]) {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt,
                    target: peer.target,
                }),
            );
            const messageIds = new Set<string>();
            const contentTypes: string[] = [];
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk") {
                    if (typeof event.payload.messageId !== "string" || event.payload.messageId.length === 0) {
                        throw new Error("Pi did not identify its reply");
                    }
                    messageIds.add(event.payload.messageId);
                    contentTypes.push(event.payload.content.type);
                    if (prompt === "/session" || prompt === "/steering") {
                        expect(event.payload.content).toMatchObject({
                            type: "text",
                            text: expect.stringContaining(prompt === "/session" ? "Session:" : "Steering mode:"),
                        });
                    }
                } else if (event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk") {
                    expect(prompt).toBe("Begin");
                } else if (
                    event.type === "lifecycle-metadata" &&
                    (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                ) {
                    throw new Error(JSON.stringify(event));
                } else if (
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.completed" &&
                    event.payload.commandId === commandId
                ) {
                    expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
                    break;
                }
            }
            // The seed prompt can also deliver the independently identified startup notice.
            // Only the local commands under test must produce exactly one reply identity.
            if (prompt === "Begin") {
                expect(messageIds.size).toBeGreaterThan(0);
            } else {
                expect(messageIds.size).toBe(1);
            }
            for (const id of messageIds) {
                expect(id).toEqual(expect.any(String));
                expect(replyIds.has(id)).toBe(false);
                replyIds.add(id);
            }
            if (prompt === "/export") {
                expect(contentTypes).toEqual(["text", "resource_link"]);
            }
        }
    });
});

test("Given real Pi transforms user input, When a prompt runs through the daemon, Then live user chunks show only the native consumed content", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_NATIVE_INPUT_REPLY");
    await using agent = await PiFixture.create(provider);
    await agent.installExtension(
        "transform-input.js",
        `export default function (pi) {
            pi.on("input", async () => ({ action: "transform", text: "PI_NATIVE_CONSUMED_INPUT" }));
        }`,
    );
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                commandId,
                requestId: commandId,
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "Original request before native transformation",
                target: peer.target,
            }),
        );
        const userContent: unknown[] = [];
        let text = "";
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk") {
                userContent.push(event.payload.content);
                expect(event.payload.messageId).toEqual(expect.any(String));
            } else if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                text += event.payload.content.text;
            } else if (
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
            ) {
                throw new Error(JSON.stringify(event));
            } else if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === commandId
            ) {
                expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
                break;
            }
        }
        expect(userContent).toEqual([{ type: "text", text: "PI_NATIVE_CONSUMED_INPUT" }]);
        expect(text).toContain("PI_NATIVE_INPUT_REPLY: plain response");
    });
});

test("Given real Pi has an active SDK turn, When the user steers it, Then Pi continues the same turn with the steering prompt", async () => {
    const activeEntered = Promise.withResolvers<void>();
    const releaseActive = Promise.withResolvers<void>();
    let responseNumber = 0;
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "REAL_PI_STEERING_REPLY", {
        beforeFirstText: async () => {
            responseNumber += 1;
            if (responseNumber === 1) {
                activeEntered.resolve();
                await releaseActive.promise;
            }
        },
    });
    await using agent = await PiFixture.create(provider);
    try {
        await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
            const activeCommandId = randomUUID();
            const steeringCommandId = randomUUID();
            const sendPrompt = (commandId: string, prompt: string): void =>
                peer.send(
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: commandId,
                        disposition: SessionPromptDisposition.Append,
                        attachments: [],
                        kind: "session.prompt",
                        prompt,
                        target: peer.target,
                    }),
                );

            sendPrompt(activeCommandId, "Start the task and wait for updated instructions");
            await activeEntered.promise;
            sendPrompt(steeringCommandId, "Use the steering requirement in the same turn");
            let steeringCompleted = false;
            for (;;) {
                const message = await peer.nextMessage();
                if (
                    decodeMessageKind(message) === SESSION_EVENT_KIND &&
                    decodeSessionEventEnvelope(message).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                    )
                ) {
                    break;
                }
            }
            peer.send(
                encodeSessionPromptDispositionCommand({
                    commandId: steeringCommandId,
                    disposition: SessionPromptDisposition.Steer,
                    kind: "session.prompt.disposition",
                    requestId: crypto.randomUUID(),
                    target: peer.target,
                }),
            );

            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                for (const event of decodeSessionEventEnvelope(message).events) {
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.failed" &&
                        event.payload.commandId === steeringCommandId
                    ) {
                        throw new Error(JSON.stringify(event));
                    }
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === steeringCommandId
                    ) {
                        expect(event.payload.completion).toEqual({ kind: "steered" });
                        steeringCompleted = true;
                        releaseActive.resolve();
                    }
                }
                if (steeringCompleted) {
                    break;
                }
            }
            let text = "";
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                }
                if (
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.failed" &&
                    event.payload.commandId === activeCommandId
                ) {
                    throw new Error(JSON.stringify(event));
                }
                if (
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.completed" &&
                    event.payload.commandId === activeCommandId
                ) {
                    expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
                    break;
                }
            }
            expect(text.match(/REAL_PI_STEERING_REPLY/gu)).toHaveLength(2);
            expect(provider.diagnostics()).toHaveLength(2);
        });
    } finally {
        releaseActive.resolve();
    }
});

test("Given real Pi only supports disabled thinking, When a session is prepared, Then the daemon omits the non-configurable Thinking control", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "REAL_PI_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const requestId = randomUUID();
        peer.send(
            encodeSessionPrepareCommand({
                kind: "session.prepare",
                requestId,
                target: peer.target,
            }),
        );

        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "session.ready") {
                continue;
            }
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId !== requestId) {
                continue;
            }
            expect(ready.configOptions.filter((option) => option.category === "mode")).toEqual([]);
            expect(ready.configOptions.filter((option) => option.category === "thought_level")).toEqual([]);
            break;
        }
    });
});

test("Given real Pi without an external ACP adapter, When Bash executes through the daemon, Then the command and result are observable with both replies", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "REAL_PI_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        for (const turn of [0, 1]) {
            const prompt =
                turn === 0 ? fakeProviderPrompts.successfulTool : "Continue the conversation with another reply";
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt,
                    target: peer.target,
                }),
            );
            let text = "";
            let toolSucceeded = false;
            let toolInput: unknown;
            let toolOutput: unknown;
            const toolContent = new Map<string, readonly unknown[]>();
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                    const option = event.payload.event.options.find((entry) => entry.kind === "allow_once");
                    if (option === undefined) {
                        throw new Error("No one-time tool permission option");
                    }
                    peer.send(
                        encodeSessionPermissionRespondCommand({
                            kind: "session.permission.respond",
                            requestId: crypto.randomUUID(),
                            target: peer.target,
                            interactionId: event.payload.event.interactionId,
                            optionId: option.optionId,
                            outcome: "selected",
                        }),
                    );
                } else if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                } else if (
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
                ) {
                    if (event.payload.rawInput !== undefined) {
                        toolInput = event.payload.rawInput;
                    }
                    if (event.payload.rawOutput !== undefined) {
                        toolOutput = event.payload.rawOutput;
                    }
                    if (event.payload.content != null) {
                        toolContent.set(event.payload.toolCallId, event.payload.content);
                    }
                    if (event.payload.status === "completed") {
                        expect(toolInput).toEqual(expect.objectContaining({ command: "pwd" }));
                        expect(JSON.stringify(toolContent.get(event.payload.toolCallId))).toContain(peer.workspace);
                        expect(JSON.stringify(toolOutput)).toContain(peer.workspace);
                        toolSucceeded = true;
                    }
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.commandId).toBe(commandId);
                    expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
                    break;
                }
            }
            expect(text).toContain(provider.responseFor(prompt));
            if (turn === 0) {
                expect(toolSucceeded).toBe(true);
            }
        }
    });
});
