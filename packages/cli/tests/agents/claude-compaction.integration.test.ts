import { randomUUID } from "node:crypto";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test("Given Claude Code compacts a conversation with content, When the daemon relays the turn, Then the client receives ID-addressed compaction updates instead of text banners", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "REAL_CLAUDE_REPLY");
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const sendPrompt = (prompt: string): void => {
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
        };

        // Seed a turn so compaction has content to summarize.
        sendPrompt("Talk about something first");
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "lifecycle-metadata") {
                if (event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.payload.kind === "prompt.completed") {
                    break;
                }
            }
        }

        sendPrompt("/compact");
        const compactionIds: string[] = [];
        const statuses: string[] = [];
        const summaryChunks: string[] = [];
        const bannerTexts: string[] = [];
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
                if (update.error !== undefined && update.error !== null) {
                    throw new Error(update.error);
                }
            } else if (update.sessionUpdate === "compaction_summary_chunk") {
                summaryChunks.push(update.content.type === "text" ? update.content.text : "");
            } else if (
                update.sessionUpdate === "agent_message_chunk" &&
                update.content.type === "text" &&
                /compacting/iu.test(update.content.text)
            ) {
                bannerTexts.push(update.content.text);
            }
        }
        // One compaction: opened and settled by the same Agent-owned ID, with no
        // synthesized "Compacting..." text banners.
        expect(statuses).toEqual(["in_progress", "completed"]);
        expect(new Set(compactionIds).size).toBe(1);
        expect(bannerTexts).toEqual([]);
        // When the CLI streams the summary it produced, every chunk addresses the
        // same compaction.
        for (const chunk of summaryChunks) {
            expect(chunk.length).toBeGreaterThan(0);
        }
    });
});
