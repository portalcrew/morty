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

test("Given native text and structured task snapshots with delimiter-heavy subjects, When Claude history is previewed, Then each task plan is recovered with its original subject and status", async ({
    signal,
}) => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "UNUSED_TASK_HISTORY_PROVIDER");
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(signal, new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const home = agent.environment["CLAUDE_CONFIG_DIR"];
        if (home === undefined) {
            throw new Error("Missing isolated Claude home");
        }
        const nativeId = randomUUID();
        const project = join(home, "projects", peer.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
        await mkdir(project, { recursive: true });
        let parentUuid: string | null = null;
        const records: string[] = [];
        const append = (message: { readonly role: string; readonly content: unknown }, toolUseResult?: unknown) => {
            const uuid = randomUUID();
            records.push(
                JSON.stringify({
                    uuid,
                    parentUuid,
                    sessionId: nativeId,
                    type: message.role,
                    isSidechain: false,
                    cwd: peer.workspace,
                    version: "2.1.273",
                    timestamp: "2026-10-30T00:00:00.000Z",
                    message,
                    ...(toolUseResult === undefined ? {} : { toolUseResult }),
                }),
            );
            parentUuid = uuid;
        };
        const subject = `Preserve delimiters [blocked by #${"+#".repeat(40)}`;
        append({ role: "user", content: "Show my saved task plan" });
        for (const [id, output, structured] of [
            [
                "text-list",
                `#1 [pending] ${subject}\n#2 [in_progress] Continue work (agent) [blocked by #1, #3]`,
                undefined,
            ],
            ["structured-list", "Structured task snapshot", { tasks: [{ id: "1", subject, status: "completed" }] }],
        ] as const) {
            append({ role: "assistant", content: [{ type: "tool_use", id, name: "TaskList", input: {} }] });
            append({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] }, structured);
        }
        append({ role: "assistant", content: [{ type: "text", text: "Saved tasks recovered" }] });
        await writeFile(join(project, `${nativeId}.jsonl`), `${records.join("\n")}\n`);
        peer.send(
            encodeSessionPreviewHistoryPageLoad({
                directory: ".",
                cursor: null,
                eventLimit: 200,
                kind: "session.preview-history.page.load",
                requestId: "task-list-history",
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
            const plans = result.events.events.events.flatMap((event) =>
                event.type === "acp" && event.payload.sessionUpdate === "plan" ? [event.payload.entries] : [],
            );
            expect(plans).toEqual([
                [
                    { content: subject, status: "pending", priority: "medium" },
                    { content: "Continue work", status: "in_progress", priority: "medium" },
                ],
                [{ content: subject, status: "completed", priority: "medium" }],
            ]);
            break;
        }
    });
});
