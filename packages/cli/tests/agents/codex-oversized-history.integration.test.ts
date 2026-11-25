import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionHistoryPageLoaded,
    encodeNativeSessionCommand,
    encodeSessionHistoryPageLoad,
    type NativeSessionResult,
    type SessionEvent,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function photo(): string {
    return `data:image/png;base64,${Buffer.concat([PNG_SIGNATURE, randomBytes(4_800_000)]).toString("base64")}`;
}

function turn(sessionId: string, index: number, text: string, images: readonly string[], reply: string) {
    const turnId = `01a11f74-d697-70d3-94a2-${index.toString().padStart(12, "0")}`;
    return [
        {
            type: "event_msg",
            payload: {
                type: "task_started",
                turn_id: turnId,
                started_at: 1791529113,
                model_context_window: 258400,
                collaboration_mode_kind: "default",
            },
        },
        {
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text }],
                internal_chat_message_metadata_passthrough: { turn_id: turnId },
            },
        },
        {
            type: "event_msg",
            payload: { type: "user_message", message: text, attachments: [], local_attachments: [], text_elements: [] },
        },
        {
            type: "event_msg",
            payload: {
                type: "item_completed",
                thread_id: sessionId,
                turn_id: turnId,
                started_at_ms: 1791529114000,
                completed_at_ms: 1791529115000,
                item: {
                    type: "UserMessage",
                    id: `user-${index.toString()}`,
                    content: [
                        { type: "text", text, text_elements: [] },
                        ...images.map((image) => ({ type: "image", image_url: image })),
                    ],
                },
            },
        },
        {
            type: "event_msg",
            payload: {
                type: "item_completed",
                thread_id: sessionId,
                turn_id: turnId,
                started_at_ms: 1791529114000,
                completed_at_ms: 1791529115000,
                item: {
                    type: "AgentMessage",
                    id: `agent-${index.toString()}`,
                    content: [{ type: "Text", text: reply }],
                    phase: "final_answer",
                },
            },
        },
        {
            type: "event_msg",
            payload: {
                type: "task_complete",
                turn_id: turnId,
                last_agent_message: reply,
                started_at: 1791529113,
                completed_at: 1791529115,
                duration_ms: 2000,
                time_to_first_token_ms: null,
            },
        },
    ];
}

function texts(events: readonly SessionEvent[], update: "user_message_chunk" | "agent_message_chunk"): string[] {
    return events.flatMap((event) =>
        event.type === "acp" && event.payload.sessionUpdate === update && event.payload.content.type === "text"
            ? [event.payload.content.text]
            : [],
    );
}

test("Given saved Codex history over the app-server message limit, When the real daemon reopens it, Then every turn loads and only an unloadable message is replaced by a notice", async ({
    signal,
}) => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "REPLY");
    await using agent = await CodexFixture.create(provider);
    const workspace = await mkdtemp(join(tmpdir(), "morty-codex-history-"));
    try {
        const sessionId = "01a11f74-cbc4-7112-9c63-df87608c81c1";
        const timestamp = "2026-10-09T06:58:30.487Z";
        const codexHome = agent.environment["CODEX_HOME"];
        if (codexHome === undefined) {
            throw new Error("Codex fixture has no home");
        }
        const directory = join(codexHome, "sessions", "2026", "10", "09");
        await mkdir(directory, { recursive: true });
        const turns = [
            ...[1, 2, 3, 4, 5, 6].map((index) =>
                turn(sessionId, index, `Photo ${index.toString()}`, [photo()], `Reply ${index.toString()}`),
            ),
            turn(sessionId, 7, "Six photos at once", [1, 2, 3, 4, 5, 6].map(photo), "Reply 7"),
        ];
        const payloads = [
            {
                type: "session_meta",
                payload: {
                    id: sessionId,
                    timestamp,
                    cwd: workspace,
                    originator: "codex_cli_rs",
                    cli_version: "0.166.0",
                    source: "cli",
                    history_mode: "paginated",
                    model_provider: "morty",
                },
            },
            ...turns.flat(),
        ];
        // Codex indexes saved conversations when it starts, so the history exists before the daemon starts Codex.
        await writeFile(
            join(directory, `rollout-2026-10-09T06-58-30-${sessionId}.jsonl`),
            `${payloads.map((entry, ordinal) => JSON.stringify({ timestamp, ordinal, ...entry })).join("\n")}\n`,
        );
        await withRealDaemon(
            signal,
            new CodexAgentSpecification(),
            agent.environment,
            async (peer) => {
                const identity = { harness: "codex", directory: ".", kind: "native.session.request" } as const;
                const resultFor = async (requestId: string): Promise<NativeSessionResult> => {
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.operation.failed") {
                            throw new Error(message);
                        }
                        if (kind !== "native.session.result") {
                            continue;
                        }
                        const result = decodeNativeSessionResult(message);
                        if (result.requestId === requestId) {
                            return result;
                        }
                    }
                };
                peer.send(encodeNativeSessionCommand({ ...identity, action: "list", cursor: null, requestId: "list" }));
                const listed = await resultFor("list");
                if (listed.action !== "list" || !listed.entries.some((entry) => entry.sessionId === sessionId)) {
                    throw new Error("Missing saved Session");
                }
                peer.send(
                    encodeNativeSessionCommand({ ...identity, action: "import", sessionId, requestId: "import" }),
                );
                const imported = await resultFor("import");
                if (imported.action !== "import") {
                    throw new Error("Expected native import");
                }
                peer.send(
                    encodeSessionHistoryPageLoad({
                        cursor: null,
                        eventLimit: 200,
                        kind: "session.live-history.v2.page.load",
                        requestId: "history",
                        target: imported.target,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    const kind = decodeMessageKind(message);
                    if (kind === "session.operation.failed") {
                        throw new Error(message);
                    }
                    if (kind !== "session.live-history.v2.page.loaded") {
                        continue;
                    }
                    const events = decodeSessionHistoryPageLoaded(message).events.events.events;
                    expect(texts(events, "user_message_chunk")).toEqual([
                        "Photo 1",
                        "Photo 2",
                        "Photo 3",
                        "Photo 4",
                        "Photo 5",
                        "Photo 6",
                    ]);
                    expect(
                        events.filter(
                            (event) =>
                                event.type === "acp" &&
                                event.payload.sessionUpdate === "user_message_chunk" &&
                                event.payload.content.type === "external_image",
                        ),
                    ).toHaveLength(6);
                    expect(texts(events, "agent_message_chunk")).toEqual([
                        "Reply 1",
                        "Reply 2",
                        "Reply 3",
                        "Reply 4",
                        "Reply 5",
                        "Reply 6",
                        "Reply 7",
                    ]);
                    const notice = events.findIndex(
                        (event) =>
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "tool_call" &&
                            event.payload.title === "Too large to show",
                    );
                    const lastReply = events.findIndex(
                        (event) =>
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text" &&
                            event.payload.content.text === "Reply 7",
                    );
                    expect(notice).toBeGreaterThan(-1);
                    expect(notice).toBeLessThan(lastReply);
                    break;
                }
            },
            "embedded",
            workspace,
        );
    } finally {
        await rm(workspace, { force: true, recursive: true });
    }
}, 180_000);
