import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionPreviewHistoryPageLoaded,
    encodeSessionPreviewHistoryPageLoad,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test("Given Claude history contains an interrupted Write and completed Writes, When previewed through the daemon, Then incomplete input stays visible without a fabricated diff and completed content is preserved", async ({
    signal,
}) => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "UNUSED_HISTORY_PROVIDER");
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(signal, new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const home = agent.environment["CLAUDE_CONFIG_DIR"];
        if (home === undefined) {
            throw new Error("Missing isolated Claude home");
        }
        const nativeId = randomUUID();
        const project = join(home, "projects", peer.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
        await mkdir(project, { recursive: true });
        const toolCalls = [
            {
                type: "tool_use",
                id: "write-interrupted",
                name: "Write",
                input: { file_path: join(peer.workspace, "interrupted.txt") },
            },
            {
                type: "tool_use",
                id: "write-empty",
                name: "Write",
                input: { file_path: join(peer.workspace, "empty.txt"), content: "" },
            },
            {
                type: "tool_use",
                id: "write-complete",
                name: "Write",
                input: { file_path: join(peer.workspace, "complete.txt"), content: "SAVED_WRITE_CONTENT" },
            },
        ];
        const messages = [
            { role: "user", content: [{ type: "text", text: "Saved write request" }] },
            {
                role: "assistant",
                id: "saved-assistant",
                type: "message",
                model: "claude-sonnet-4-6",
                content: toolCalls,
                stop_reason: "tool_use",
                usage: { input_tokens: 1, output_tokens: 1 },
            },
            {
                role: "user",
                content: toolCalls.map((tool) => ({
                    type: "tool_result",
                    tool_use_id: tool.id,
                    content: "Saved result",
                    is_error: tool.id === "write-interrupted",
                })),
            },
            {
                role: "assistant",
                id: "saved-reply",
                type: "message",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "AFTER_SAVED_WRITES" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 1, output_tokens: 1 },
            },
        ];
        let parentUuid: string | null = null;
        const records = messages.map((message) => {
            const uuid = randomUUID();
            const record = {
                uuid,
                parentUuid,
                sessionId: nativeId,
                type: message.role,
                isSidechain: false,
                cwd: peer.workspace,
                version: "2.1.273",
                timestamp: "2026-10-24T00:00:00.000Z",
                message,
            };
            parentUuid = uuid;
            return JSON.stringify(record);
        });
        await writeFile(join(project, `${nativeId}.jsonl`), `${records.join("\n")}\n`);
        peer.send(
            encodeSessionPreviewHistoryPageLoad({
                directory: ".",
                cursor: null,
                eventLimit: 200,
                kind: "session.preview-history.page.load",
                requestId: "saved-write-preview",
                target: { harness: "claude", sessionId: nativeId },
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind !== "session.preview-history.page.loaded") {
                continue;
            }
            const result = decodeSessionPreviewHistoryPageLoaded(message);
            const updates = result.events.events.events.flatMap((event) =>
                event.type === "acp" ? [event.payload] : [],
            );
            const writes = updates.filter((update) => update.sessionUpdate === "tool_call");
            expect(writes).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        toolCallId: "write-interrupted",
                        rawInput: toolCalls[0]?.input,
                        status: "failed",
                        content: expect.not.arrayContaining([expect.objectContaining({ type: "diff" })]),
                    }),
                    expect.objectContaining({
                        toolCallId: "write-empty",
                        content: [expect.objectContaining({ type: "diff", newText: "" })],
                    }),
                    expect.objectContaining({
                        toolCallId: "write-complete",
                        content: [expect.objectContaining({ type: "diff", newText: "SAVED_WRITE_CONTENT" })],
                    }),
                ]),
            );
            expect(updates).toContainEqual(
                expect.objectContaining({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "AFTER_SAVED_WRITES" },
                }),
            );
            break;
        }
    });
});
