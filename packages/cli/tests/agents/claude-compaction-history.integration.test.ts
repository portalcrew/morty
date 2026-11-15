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

test.for(["auto", "multiple", "preservedSegment", "preservedMessages", "missingParent", "cycle"])(
    "Given a native Claude transcript with %s compaction, When history is loaded before and after daemon restart, Then full history or the malformed-chain SDK fallback is replayed",
    async (variant, { signal }) => {
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
            const records: Record<string, unknown>[] = [];
            let parentUuid: string | null = null;
            const append = (type: string, fields: Readonly<Record<string, unknown>>) => {
                const uuid = randomUUID();
                records.push({
                    uuid,
                    parentUuid,
                    sessionId: nativeId,
                    type,
                    isSidechain: false,
                    cwd: peer.workspace,
                    version: "2.1.310",
                    timestamp: "2026-10-29T00:00:00.000Z",
                    ...fields,
                });
                parentUuid = uuid;
                return uuid;
            };
            const user = (text: string) => append("user", { message: { role: "user", content: text } });
            const assistant = (text: string) =>
                append("assistant", {
                    message: { id: randomUUID(), role: "assistant", content: [{ type: "text", text }] },
                });
            const firstUser = user("FIRST_USER_TURN");
            const firstAssistant = assistant("FIRST_ASSISTANT_REPLY");
            const firstReply = records.find((record) => record["uuid"] === firstAssistant)?.["message"];
            if (typeof firstReply !== "object" || firstReply === null || !("id" in firstReply)) {
                throw new Error("Missing reply");
            }
            append("assistant", {
                parentUuid: firstUser,
                message: {
                    id: firstReply.id,
                    role: "assistant",
                    content: [
                        { type: "tool_use", id: "history-tool", name: "Bash", input: { command: "echo history" } },
                    ],
                },
            });
            append("user", {
                message: {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: "history-tool", content: "HISTORY_TOOL_RESULT" }],
                },
            });
            const preservedHead = user("PRESERVED_USER_TURN");
            const preservedTail = assistant("PRESERVED_ASSISTANT_REPLY");
            const count = variant === "multiple" ? 2 : 1;
            const boundaries: string[] = [];
            for (let index = 0; index < count; index++) {
                const logicalParentUuid = variant === "missingParent" ? randomUUID() : parentUuid;
                const boundary = append("system", {
                    parentUuid: null,
                    logicalParentUuid,
                    subtype: "compact_boundary",
                    content: "Conversation compacted",
                    compactMetadata: { trigger: "auto", preTokens: 969000 },
                });
                boundaries.push(boundary);
                if (variant === "cycle") {
                    const record = records.find((record) => record["uuid"] === boundary);
                    if (record === undefined) {
                        throw new Error("Missing boundary");
                    }
                    record["logicalParentUuid"] = boundary;
                }
                const summary = append("user", {
                    isCompactSummary: true,
                    message: { role: "user", content: `COMPACTION_SUMMARY_${index}` },
                });
                if (variant === "preservedSegment" || variant === "preservedMessages") {
                    const record = records.find((record) => record["uuid"] === boundary);
                    if (record === undefined) {
                        throw new Error("Missing boundary");
                    }
                    record["compactMetadata"] = {
                        trigger: "auto",
                        preTokens: 969000,
                        ...(variant === "preservedSegment"
                            ? {
                                  preservedSegment: {
                                      headUuid: preservedHead,
                                      tailUuid: preservedTail,
                                      anchorUuid: summary,
                                  },
                              }
                            : { preservedMessages: { uuids: [preservedHead, preservedTail], anchorUuid: summary } }),
                    };
                }
                user(`AFTER_COMPACTION_${index}`);
                assistant(`AFTER_REPLY_${index}`);
            }
            append("user", {
                parentUuid: records[0]?.["uuid"],
                isSidechain: true,
                message: { role: "user", content: "HIDDEN_SIDECHAIN" },
            });
            await writeFile(
                join(project, `${nativeId}.jsonl`),
                `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
            );
            for (const restarted of [false, true]) {
                if (restarted) {
                    await peer.restart();
                }
                peer.send(
                    encodeSessionPreviewHistoryPageLoad({
                        directory: ".",
                        cursor: null,
                        eventLimit: 200,
                        kind: "session.preview-history.page.load",
                        requestId: "compaction-history",
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
                    const users = updates.flatMap((update) =>
                        update.sessionUpdate === "user_message_chunk" && update.content.type === "text"
                            ? [update.content.text]
                            : [],
                    );
                    if (variant === "missingParent" || variant === "cycle") {
                        // Structurally invalid extended chains retain the SDK's
                        // supported current-context replay instead of failing load.
                        expect(users).toEqual(["COMPACTION_SUMMARY_0", "AFTER_COMPACTION_0"]);
                        expect(updates.filter((update) => update.sessionUpdate === "compaction_update")).toEqual([]);
                        break;
                    }
                    expect(users).toEqual([
                        "FIRST_USER_TURN",
                        "PRESERVED_USER_TURN",
                        ...Array.from({ length: count }, (_, index) => `AFTER_COMPACTION_${index}`),
                    ]);
                    const replies = updates.flatMap((update) =>
                        update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
                            ? [update.content.text]
                            : [],
                    );
                    expect(replies).toContain("FIRST_ASSISTANT_REPLY");
                    expect(replies.filter((text) => text === "PRESERVED_ASSISTANT_REPLY")).toHaveLength(1);
                    expect(updates).toContainEqual(
                        expect.objectContaining({
                            sessionUpdate: "tool_call",
                            toolCallId: "history-tool",
                            status: "completed",
                        }),
                    );
                    expect(updates.filter((update) => update.sessionUpdate === "compaction_update")).toEqual(
                        boundaries.map((compactionId) =>
                            expect.objectContaining({ compactionId, status: "completed" }),
                        ),
                    );
                    expect(updates.filter((update) => update.sessionUpdate === "compaction_summary_chunk")).toEqual(
                        boundaries.map((compactionId, index) =>
                            expect.objectContaining({
                                compactionId,
                                content: { type: "text", text: `COMPACTION_SUMMARY_${index}` },
                            }),
                        ),
                    );
                    break;
                }
            }
        });
    },
);
