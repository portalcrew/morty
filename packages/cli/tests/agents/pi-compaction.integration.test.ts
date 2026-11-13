import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    decodeSessionPreviewHistoryPageLoaded,
    encodeSessionHistoryPageLoad,
    encodeSessionPreviewHistoryPageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given pi compacts the conversation, When the daemon relays the turn, Then the client receives the compaction lifecycle and the retained summary", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "REAL_PI_REPLY");
    await using agent = await PiFixture.create(provider);
    // pi keeps the most recent `keepRecentTokens` tokens out of compaction
    // (default 20 000 — more than this whole session). Shrink it so a couple of
    // seeded turns leave something to summarize.
    await agent.overrideSettings({ compaction: { keepRecentTokens: 1 } });
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
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

        // Seed enough turns that pi considers the session worth compacting.
        for (const topic of ["archaeology", "bicycles", "coffee"]) {
            sendPrompt(`Talk about ${topic} with some detail`);
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
        }

        sendPrompt("/compact");
        const statuses: string[] = [];
        const compactionIds: string[] = [];
        const summaryText: string[] = [];
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
            } else if (update.sessionUpdate === "compaction_summary_chunk") {
                compactionIds.push(update.compactionId);
                summaryText.push(update.content.type === "text" ? update.content.text : "");
            } else if (
                update.sessionUpdate === "agent_message_chunk" &&
                update.content.type === "text" &&
                /compaction/iu.test(update.content.text)
            ) {
                bannerTexts.push(update.content.text);
            }
        }
        // The adapter-reported lifecycle: opened, streamed its summary chunk, and
        // settled, all addressed to one compaction ID — with no text banners.
        expect(statuses).toEqual(["in_progress", "completed"]);
        expect(new Set(compactionIds).size).toBe(1);
        expect(bannerTexts).toEqual([]);
        // pi returns the summary it retained from its compact RPC.
        expect(summaryText.join("").length).toBeGreaterThan(0);

        // Given a compacted native session, a Computer restart must replay the
        // conversation rather than just Pi's current model context.
        await peer.restart();
        const requestId = randomUUID();
        peer.send(
            encodeSessionHistoryPageLoad({
                cursor: null,
                eventLimit: 200,
                kind: "session.live-history.v2.page.load",
                requestId,
                target: peer.target,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                continue;
            }
            const page = decodeSessionHistoryPageLoaded(message);
            if (page.requestId !== requestId) {
                continue;
            }
            const updates = page.events.events.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
            expect(
                updates.flatMap((update) =>
                    update.sessionUpdate === "user_message_chunk" && update.content.type === "text"
                        ? [update.content.text]
                        : [],
                ),
            ).toEqual(["archaeology", "bicycles", "coffee"].map((topic) => `Talk about ${topic} with some detail`));
            expect(updates.filter((update) => update.sessionUpdate === "compaction_update")).toEqual([
                expect.objectContaining({ status: "completed" }),
            ]);
            expect(
                updates.flatMap((update) =>
                    update.sessionUpdate === "compaction_summary_chunk" && update.content.type === "text"
                        ? [update.content.text]
                        : [],
                ),
            ).toEqual(summaryText);
            break;
        }
    });
});

test.each([false, true])(
    "Given native Pi bash execution with compacted=%s and a split tool turn, When history is previewed, Then the full active branch and retained compactions remain visible",
    async (compacted) => {
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "UNUSED_REPLY");
        await using agent = await PiFixture.create(provider);
        await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
            const sessionId = randomUUID();
            const directory = join(agent.environment["HOME"] ?? "", ".pi", "agent", "sessions");
            await mkdir(directory, { recursive: true });
            const timestamp = "2026-10-27T13:47:00.000Z";
            const usage = {
                input: 20,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 30,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
            const rows = [
                { type: "session", version: 3, id: sessionId, timestamp, cwd: peer.workspace },
                {
                    type: "message",
                    id: "user1",
                    parentId: null,
                    timestamp,
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "Before automatic compaction" }],
                        timestamp: 1793108820000,
                    },
                },
                {
                    type: "message",
                    id: "bash",
                    parentId: "user1",
                    timestamp,
                    message: {
                        role: "bashExecution",
                        command: "printf native-shell-output",
                        output: "native-shell-output",
                        exitCode: 0,
                        cancelled: false,
                        truncated: false,
                        timestamp: 1793108820000,
                    },
                },
                {
                    type: "message",
                    id: "tool",
                    parentId: "bash",
                    timestamp,
                    message: {
                        role: "assistant",
                        api: "openai-completions",
                        provider: "openai",
                        model: "gpt-4.1",
                        usage,
                        stopReason: "toolUse",
                        timestamp: 1793108820000,
                        content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "notes.txt" } }],
                    },
                },
                {
                    type: "message",
                    id: "result",
                    parentId: "tool",
                    timestamp,
                    message: {
                        role: "toolResult",
                        toolCallId: "read1",
                        toolName: "read",
                        content: [{ type: "text", text: "Saved notes" }],
                        isError: false,
                        timestamp: 1793108820000,
                    },
                },
                {
                    type: "compaction",
                    id: "compact1",
                    parentId: "result",
                    timestamp,
                    summary: "First automatic summary",
                    firstKeptEntryId: "tool",
                    tokensBefore: 1000,
                },
                {
                    type: "message",
                    id: "abandoned",
                    parentId: compacted ? "compact1" : "result",
                    timestamp,
                    message: { role: "user", content: "Abandoned branch", timestamp: 1793108820000 },
                },
                {
                    type: "message",
                    id: "user2",
                    parentId: compacted ? "compact1" : "result",
                    timestamp,
                    message: { role: "user", content: "Between compactions", timestamp: 1793108820000 },
                },
                {
                    type: "message",
                    id: "reply2",
                    parentId: "user2",
                    timestamp,
                    message: {
                        role: "assistant",
                        api: "openai-completions",
                        provider: "openai",
                        model: "gpt-4.1",
                        usage,
                        stopReason: "stop",
                        timestamp: 1793108820000,
                        content: [{ type: "text", text: "Retained assistant reply" }],
                    },
                },
                {
                    type: "compaction",
                    id: "compact2",
                    parentId: "reply2",
                    timestamp,
                    summary: "Second automatic summary",
                    firstKeptEntryId: "user2",
                    tokensBefore: 2000,
                },
                {
                    type: "message",
                    id: "user3",
                    parentId: compacted ? "compact2" : "reply2",
                    timestamp,
                    message: { role: "user", content: "After compaction", timestamp: 1793108820000 },
                },
            ];
            await writeFile(
                join(directory, `${sessionId}.jsonl`),
                `${rows
                    .filter((row) => compacted || row.type !== "compaction")
                    .map((row) => JSON.stringify(row))
                    .join("\n")}\n`,
            );
            const requestId = randomUUID();
            peer.send(
                encodeSessionPreviewHistoryPageLoad({
                    directory: ".",
                    cursor: null,
                    eventLimit: 200,
                    kind: "session.preview-history.page.load",
                    requestId,
                    target: { harness: "pi", sessionId: sessionId },
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.preview-history.page.loaded") {
                    if (decodeMessageKind(message) === "session.operation.failed") {
                        throw new Error(message);
                    }
                    continue;
                }
                const page = decodeSessionPreviewHistoryPageLoaded(message);
                if (page.requestId !== requestId) {
                    continue;
                }
                const updates = page.events.events.events.flatMap((event) =>
                    event.type === "acp" ? [event.payload] : [],
                );
                expect(
                    updates.flatMap((update) =>
                        update.sessionUpdate === "user_message_chunk" && update.content.type === "text"
                            ? [update.content.text]
                            : [],
                    ),
                ).toEqual(["Before automatic compaction", "Between compactions", "After compaction"]);
                expect(
                    updates.flatMap((update) =>
                        update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
                            ? [update.content.text]
                            : [],
                    ),
                ).toEqual(["Retained assistant reply"]);
                expect(updates.filter((update) => update.sessionUpdate === "compaction_update")).toEqual(
                    compacted
                        ? [
                              expect.objectContaining({ compactionId: "compact1", status: "completed" }),
                              expect.objectContaining({ compactionId: "compact2", status: "completed" }),
                          ]
                        : [],
                );
                expect(
                    updates.flatMap((update) =>
                        update.sessionUpdate === "compaction_summary_chunk" && update.content.type === "text"
                            ? [update.content.text]
                            : [],
                    ),
                ).toEqual(compacted ? ["First automatic summary", "Second automatic summary"] : []);
                expect(updates.filter((update) => update.sessionUpdate === "tool_call")).toEqual([
                    expect.objectContaining({
                        toolCallId: "read1",
                        status: "completed",
                        content: [{ type: "content", content: { type: "text", text: "Saved notes" } }],
                    }),
                ]);
                break;
            }
        });
    },
);
