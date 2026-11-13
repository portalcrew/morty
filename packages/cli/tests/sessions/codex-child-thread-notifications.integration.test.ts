import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    type SessionEventPayload,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

// A controlled Codex app-server whose turn interleaves notifications from a child (subagent)
// thread with the parent thread's own, all on the parent's connection, then finishes the parent's
// command after the turn has completed.
const CONTROLLED_CODEX = `#!${process.execPath}
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
    process.stdout.write("codex-cli 0.154.0\\n");
    process.exit(0);
}
if (process.argv[2] !== "app-server") {
    process.exit(1);
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const command = (id, status) => ({ type: "commandExecution", id, command: "sleep 100", cwd: "/tmp", status });
createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "thread/start") {
        send({ id: request.id, result: { thread: { id: "parent-thread" } } });
        return;
    }
    if (request.method === "turn/start") {
        const threadId = request.params.threadId;
        const turn = { id: "parent-turn", status: "inProgress" };
        const child = { threadId: "child-thread", turnId: "child-turn" };
        send({ id: request.id, result: { turn } });
        send({ method: "turn/started", params: { threadId, turn } });
        send({ method: "item/started", params: { threadId, turnId: turn.id,
            item: { type: "userMessage", id: "parent-user", clientId: request.params.clientUserMessageId, content: request.params.input },
        } });
        send({ method: "item/agentMessage/delta", params: { ...child, itemId: "child-message", delta: "CHILD_DELTA" } });
        send({ method: "item/completed", params: { ...child, item: { type: "agentMessage", id: "child-message", text: "CHILD_REPORT" } } });
        send({ method: "thread/name/updated", params: { threadId: child.threadId, threadName: "Child nickname" } });
        send({ method: "item/started", params: { ...child, item: command("child-command", "inProgress") } });
        send({ method: "item/completed", params: { threadId, turnId: turn.id, item: { type: "agentMessage", id: "parent-message", text: "PARENT_SUMMARY" } } });
        send({ method: "thread/name/updated", params: { threadId, threadName: "Parent title" } });
        send({ method: "item/started", params: { threadId, turnId: turn.id, item: command("parent-command", "inProgress") } });
        send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
        send({ method: "item/completed", params: { threadId, turnId: turn.id, item: { ...command("parent-command", "completed"), exitCode: 0 } } });
        return;
    }
    const result = request.method === "model/list" ? { data: [], nextCursor: null } : {};
    send({ id: request.id, result });
});
`;

// @no-uc: Technical regression; Codex subagent threads must not leak into the parent Session at the daemon boundary.
test("Given a Codex turn whose subagent thread reports on the same connection, When a member's prompt runs through the daemon, Then only the parent thread's reply, title and command reach the Session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-controlled-codex-threads-"));
    try {
        const executable = join(directory, "codex.mjs");
        await writeFile(executable, CONTROLLED_CODEX, { mode: 0o700 });
        const missing = join(directory, "missing-agent");
        const environment = { MORTY_CLAUDE_PATH: missing, MORTY_CODEX_PATH: executable, MORTY_PI_PATH: missing };
        await withRealDaemon(new CodexAgentSpecification(), environment, async (peer) => {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    kind: "session.prompt",
                    requestId: commandId,
                    commandId,
                    requestId: commandId,
                    target: peer.target,
                    attachments: [],
                    prompt: "Delegate the work to a subagent",
                    disposition: SessionPromptDisposition.Append,
                    sessionConfigurations: [],
                }),
            );
            const live: SessionEventPayload[] = [];
            let promptCompleted = false;
            let parentCommandCompleted = false;
            while (!promptCompleted || !parentCommandCompleted) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                live.push(event);
                if (event.type === "lifecycle-metadata") {
                    if (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start") {
                        throw new Error(JSON.stringify(event));
                    }
                    if (event.payload.kind === "prompt.completed" && event.payload.commandId === commandId) {
                        expect(event.payload.stopReason).toBe("end_turn");
                        promptCompleted = true;
                    }
                }
                // The parent's command finishes after its turn completed; it is the Agent's last update.
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "tool_call_update" &&
                    event.payload.toolCallId === "parent-command" &&
                    event.payload.status === "completed"
                ) {
                    parentCommandCompleted = true;
                }
            }
            const updates = live.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
            expect(
                updates.flatMap((update) =>
                    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
                        ? [update.content.text]
                        : [],
                ),
            ).toEqual(["PARENT_SUMMARY"]);
            expect(
                updates.flatMap((update) =>
                    update.sessionUpdate === "session_info_update" && typeof update.title === "string"
                        ? [update.title]
                        : [],
                ),
            ).toEqual(["Parent title"]);
            expect(
                updates.flatMap((update) =>
                    update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
                        ? [{ toolCallId: update.toolCallId, backgroundTask: update.backgroundTask }]
                        : [],
                ),
            ).toEqual([
                { toolCallId: "parent-command", backgroundTask: undefined },
                { toolCallId: "parent-command", backgroundTask: { id: "parent-command", status: "running" } },
                { toolCallId: "parent-command", backgroundTask: { id: "parent-command", status: "completed" } },
            ]);
        });
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
