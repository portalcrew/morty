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

test("Given a real Claude native Session with 6000 saved messages, When its preview is loaded through the daemon, Then the in-process adapter delivers every message in order", async ({
    signal,
}) => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "UNUSED_HISTORY_PROVIDER");
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(signal, new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const home = agent.environment["CLAUDE_CONFIG_DIR"];
        if (home === undefined) {
            throw new Error("The Claude fixture requires an isolated configuration directory");
        }
        const nativeId = randomUUID();
        const project = join(home, "projects", peer.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
        await mkdir(project, { recursive: true });
        let parentUuid: string | null = null;
        const records = Array.from({ length: 6000 }, (_, index) => {
            const uuid = randomUUID();
            const record = {
                uuid,
                parentUuid,
                sessionId: nativeId,
                type: "user",
                isSidechain: false,
                cwd: peer.workspace,
                version: "2.1.273",
                timestamp: "2026-10-24T00:00:00.000Z",
                message: { role: "user", content: [{ type: "text", text: `Saved message ${index}` }] },
            };
            parentUuid = uuid;
            return JSON.stringify(record);
        });
        await writeFile(join(project, `${nativeId}.jsonl`), `${records.join("\n")}\n`);
        peer.send(
            encodeSessionPreviewHistoryPageLoad({
                directory: ".",
                cursor: null,
                eventLimit: 10000,
                kind: "session.preview-history.page.load",
                requestId: "real-claude-large-preview",
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
            const text = result.events.events.events.flatMap((event) =>
                event.type === "acp" &&
                event.payload.sessionUpdate === "user_message_chunk" &&
                event.payload.content.type === "text"
                    ? [event.payload.content.text]
                    : [],
            );
            expect(text).toEqual(Array.from({ length: 6000 }, (_, index) => `Saved message ${index}`));
            break;
        }
    });
});
