import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a real Codex conversation, When the user sends slash-prefixed text other than /compact, Then it follows the ordinary prompt path and the conversation continues", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "REAL_PROMPT_REPLY");
    await using codex = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        for (const prompt of ["Hello", "/not-a-command", "Continue the conversation"]) {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    kind: "session.prompt",
                    commandId,
                    requestId: commandId,
                    target: peer.target,
                    attachments: [],
                    prompt,
                    disposition: SessionPromptDisposition.Append,
                }),
            );
            let text = "";
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (
                    event.type === "lifecycle-metadata" &&
                    "commandId" in event.payload &&
                    event.payload.commandId !== commandId
                ) {
                    continue;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
            expect(text).toContain("REAL_PROMPT_REPLY");
        }
    });
});

test("Given a real Codex conversation with content, When the user sends /compact, Then Codex runs a manual compaction and reports its lifecycle", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "REAL_PROMPT_REPLY");
    await using codex = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const sendPrompt = (prompt: string): void => {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    kind: "session.prompt",
                    commandId,
                    requestId: commandId,
                    target: peer.target,
                    attachments: [],
                    prompt,
                    disposition: SessionPromptDisposition.Append,
                }),
            );
        };

        let compactAdvertised = false;
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
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind === "session.ready") {
                compactAdvertised = decodeSessionReadyEvent(message).commands.some(
                    (command) => command.name === "compact",
                );
                break;
            }
        }
        // Seed a turn so compaction has content to summarize.
        sendPrompt("Talk about something first");
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "acp" && event.payload.sessionUpdate === "available_commands_update") {
                compactAdvertised = event.payload.availableCommands.some((command) => command.name === "compact");
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                break;
            }
        }

        sendPrompt("/compact");
        const statuses: string[] = [];
        const compactionIds: string[] = [];
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "lifecycle-metadata") {
                if (event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.payload.kind === "prompt.completed") {
                    break;
                }
                continue;
            }
            const update = event.payload;
            if (update.sessionUpdate === "compaction_update") {
                compactionIds.push(update.compactionId);
                statuses.push(update.status);
                if (update.error != null) {
                    throw new Error(update.error);
                }
            }
        }
        expect(statuses).toEqual(["in_progress", "completed"]);
        expect(new Set(compactionIds).size).toBe(1);
        expect(compactAdvertised).toBe(true);
    });
});

test("Given a real Codex conversation with content, When the manual /compact's summarization call fails, Then the opened compaction settles failed under the same id and the prompt fails", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "REAL_PROMPT_REPLY", {
        failPromptContaining: "CONTEXT CHECKPOINT COMPACTION",
    });
    await using codex = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const sendPrompt = (prompt: string): void => {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    kind: "session.prompt",
                    commandId,
                    requestId: commandId,
                    target: peer.target,
                    attachments: [],
                    prompt,
                    disposition: SessionPromptDisposition.Append,
                }),
            );
        };

        // Seed a turn so compaction has content to summarize.
        sendPrompt("Talk about something first");
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                break;
            }
        }

        sendPrompt("/compact");
        const statuses: string[] = [];
        const compactionIds: string[] = [];
        let promptFailed = false;
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "lifecycle-metadata") {
                if (event.payload.kind === "prompt.failed") {
                    promptFailed = true;
                    break;
                }
                if (event.payload.kind === "prompt.completed") {
                    break;
                }
                continue;
            }
            const update = event.payload;
            if (update.sessionUpdate === "compaction_update") {
                compactionIds.push(update.compactionId);
                statuses.push(update.status);
            }
        }
        // The compaction the client saw open (item/started) must close under the
        // same id as failed, and the turn must fail rather than time out or report
        // an unobserved success.
        expect(promptFailed).toBe(true);
        expect(statuses).toEqual(["in_progress", "failed"]);
        expect(new Set(compactionIds).size).toBe(1);
    });
});
