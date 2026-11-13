import { randomUUID } from "node:crypto";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given Codex auto-compacts a conversation, When the daemon relays the turns, Then the client receives the compaction lifecycle", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "REAL_CODEX_REPLY");
    // An auto-compact limit below the fixture session's footprint makes Codex
    // compact during a turn instead of waiting for a real context window to fill.
    await using codex = await CodexFixture.create(provider, { autoCompactTokenLimit: 1 });
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const compactionStatuses: string[] = [];
        const compactionIds: string[] = [];
        for (const prompt of [
            "Talk about archaeology with plenty of detail",
            "Continue the conversation",
            "Continue once more",
        ]) {
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
                    compactionStatuses.push(update.status);
                }
            }
        }
        // At least one compaction opened and settled; every lifecycle update is
        // addressed by an Agent-owned id.
        expect(compactionStatuses.length).toBeGreaterThanOrEqual(2);
        expect(compactionStatuses).toContain("in_progress");
        expect(compactionStatuses.at(-1)).toBe("completed");
        expect(compactionIds.every((id) => id.length > 0)).toBe(true);
    });
});
