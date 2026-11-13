import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    decodeContentChunkFrame,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    encodeFileReadCommand,
    encodeNativeSessionCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    type NativeSessionResult,
    type SessionEvent,
    type SessionLiveEvent,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
);

function imageKeys(events: readonly (SessionEvent | SessionLiveEvent)[]): readonly string[] {
    return events.flatMap((event) => {
        if (
            event.type !== "acp" ||
            (event.payload.sessionUpdate !== "tool_call" && event.payload.sessionUpdate !== "tool_call_update")
        ) {
            return [];
        }
        return (event.payload.content ?? []).flatMap((item) =>
            item.type === "content" && item.content.type === "external_image" ? [item.content.imageKey] : [],
        );
    });
}

function openedImageKeys(events: readonly SessionEvent[]): readonly string[] {
    return events.flatMap((event) => {
        if (event.type !== "acp" || event.payload.sessionUpdate !== "tool_call") {
            return [];
        }
        return (event.payload.content ?? []).flatMap((item) =>
            item.type === "content" && item.content.type === "external_image" ? [item.content.imageKey] : [],
        );
    });
}

test("Given saved Codex image generation, When the real daemon reopens it through Codex, Then history opens the tool, retrieves its image without base64 and can continue chatting", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "IMAGE_REPLY");
    await using agent = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), agent.environment, async (peer) => {
        const sessionId = "01a11f74-cbc4-7112-9c63-df87608c81c0";
        const timestamp = "2026-10-09T06:58:30.487Z";
        const turnId = "01a11f74-d697-70d3-94a2-e232d358e56d";
        const codexHome = agent.environment["CODEX_HOME"];
        if (codexHome === undefined) {
            throw new Error("Codex fixture has no home");
        }
        const directory = join(codexHome, "sessions", "2026", "10", "09");
        await mkdir(directory, { recursive: true });
        // Native persisted input, reduced from an actual Codex image-generation rollout.
        // The real app-server reconstructs the thread; no app-server peer is simulated.
        const payloads = [
            {
                type: "session_meta",
                payload: {
                    id: sessionId,
                    timestamp,
                    cwd: peer.workspace,
                    originator: "codex_cli_rs",
                    cli_version: "0.154.0",
                    source: "cli",
                    history_mode: "paginated",
                    model_provider: "morty",
                },
            },
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
                    content: [{ type: "input_text", text: "Generate an image" }],
                    internal_chat_message_metadata_passthrough: { turn_id: turnId },
                },
            },
            {
                type: "event_msg",
                payload: {
                    type: "user_message",
                    message: "Generate an image",
                    attachments: [],
                    local_attachments: [],
                    text_elements: [],
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
                        type: "Extension",
                        kind: "image_gen.generation",
                        id: "exec-1c6dffc5-d98e-4d6c-8d84-69fa8ae1a12d",
                        transparentBackground: false,
                        savedPath: join(peer.workspace, "generated.png"),
                        status: "completed",
                        revisedPrompt: "An orange robot",
                        result: image.toString("base64"),
                        failure: null,
                    },
                },
            },
            {
                type: "event_msg",
                payload: {
                    type: "task_complete",
                    turn_id: turnId,
                    last_agent_message: null,
                    started_at: 1791529113,
                    completed_at: 1791529115,
                    duration_ms: 2000,
                    time_to_first_token_ms: null,
                },
            },
        ];
        await writeFile(
            join(directory, `rollout-2026-10-09T06-58-30-${sessionId}.jsonl`),
            `${payloads.map((entry, ordinal) => JSON.stringify({ timestamp, ordinal, ...entry })).join("\n")}\n`,
        );
        const identity = {
            harness: "codex",
            directory: ".",
            kind: "native.session.request",
        } as const;
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
        peer.send(encodeNativeSessionCommand({ ...identity, action: "list", cursor: null, requestId: "image-list" }));
        const listed = await resultFor("image-list");
        if (listed.action !== "list") {
            throw new Error("Expected native Session directory");
        }
        const source = listed.entries.find((entry) => entry.sessionId === sessionId);
        if (source === undefined) {
            throw new Error("Missing saved image Session");
        }
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "import",
                sessionId: source.sessionId,
                requestId: "image-import",
            }),
        );
        const imported = await resultFor("image-import");
        if (imported.action !== "import") {
            throw new Error("Expected native import");
        }
        expect(imported).toMatchObject({
            action: "import",
            ready: { restored: true, target: { harness: "codex", sessionId: sessionId } },
            target: { harness: "codex", sessionId: sessionId },
        });
        const key = createHash("sha256").update(image).digest("hex");
        const sendPrompt = (commandId: string, prompt: string): void =>
            peer.send(
                encodeSessionPromptCommand({
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt,
                    target: imported.target,
                }),
            );
        const finish = async (): Promise<readonly SessionLiveEvent[]> => {
            const events: SessionLiveEvent[] = [];
            for (;;) {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                expect(message).not.toContain(image.toString("base64"));
                if (kind === "session.operation.failed") {
                    throw new Error(message);
                }
                if (kind === "session.event.v2") {
                    for (const event of decodeSessionEventEnvelope(message).events) {
                        events.push(event);
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                            throw new Error(JSON.stringify(event));
                        }
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                            return events;
                        }
                    }
                }
            }
        };
        peer.send(
            encodeSessionHistoryPageLoad({
                cursor: null,
                eventLimit: 50,
                kind: "session.live-history.v2.page.load",
                requestId: "image-history",
                target: imported.target,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind === "session.live-history.v2.page.loaded") {
                expect(message).not.toContain(image.toString("base64"));
                expect(message.length).toBeLessThan(50_000);
                const events = decodeSessionHistoryPageLoaded(message).events.events.events;
                expect(imageKeys(events)).toContain(key);
                expect(openedImageKeys(events)).toContain(key);
                break;
            }
        }
        peer.send(
            encodeFileReadCommand({
                kind: "file.read",
                maxBytes: 2_000_000,
                path: `morty-content:image:${key}`,
                requestId: "image-download",
                target: imported.target,
            }),
        );
        const chunks: Buffer[] = [];
        for (;;) {
            const message = await peer.nextFrame();
            if (typeof message !== "string") {
                chunks.push(Buffer.from(decodeContentChunkFrame(message).bytes));
                continue;
            }
            const kind = decodeMessageKind(message);
            if (kind === "file.failed") {
                throw new Error(message);
            }
            if (kind === "file.end") {
                break;
            }
        }
        expect(Buffer.concat(chunks)).toEqual(image);
        sendPrompt("continue-turn", "Continue with a short reply, without using tools");
        await finish();
    });
});
