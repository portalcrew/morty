import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionLiveEvent,
    decodeSessionPreviewHistoryPageLoaded,
    encodeSessionPermissionRespondCommand,
    encodeSessionPreviewHistoryPageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { expect, test, vi } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { IdleTimeoutTimer } from "../support/idle-timeout-timer.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

test("Given native task notifications and user-pasted notification text, When Claude history is previewed, Then native outcomes update the original tools and only actual user text is a user message", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "UNUSED_HISTORY_PROVIDER");
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const home = agent.environment["CLAUDE_CONFIG_DIR"];
        if (home === undefined) {
            throw new Error("Missing isolated Claude home");
        }
        const nativeId = randomUUID();
        const project = join(home, "projects", peer.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
        await mkdir(project, { recursive: true });
        let parentUuid: string | null = null;
        const records: string[] = [];
        const append = (
            message: { readonly role: string; readonly content: unknown },
            origin?: { readonly kind: string },
            toolUseResult?: unknown,
        ) => {
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
                    timestamp: "2026-10-26T00:00:00.000Z",
                    message,
                    ...(toolUseResult === undefined ? {} : { toolUseResult }),
                    ...(origin ? { origin, promptSource: "system", queueTranscriptOnly: true } : {}),
                }),
            );
            parentUuid = uuid;
        };
        const notification = (status: string, tool: string) =>
            `<task-notification><task-id>task-${status}</task-id><tool-use-id>${tool}</tool-use-id><status>${status}</status><summary>Native ${status} outcome</summary></task-notification>`;
        const pasted = notification("stopped", "user-pasted");
        append({ role: "user", content: pasted });
        for (const status of ["completed", "failed", "stopped", "unknown"]) {
            const tool = `background-${status}`;
            append({
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: tool,
                        name: "Bash",
                        input: { command: "echo background", run_in_background: true },
                    },
                ],
            });
            append({
                role: "user",
                content: [{ type: "tool_result", tool_use_id: tool, content: "Command launched" }],
            });
            append({ role: "user", content: notification(status, tool) }, { kind: "task-notification" });
        }
        append(
            {
                role: "user",
                content:
                    "<task-notification><task-id>orphan</task-id><status>stopped</status><summary>Task interrupted</summary></task-notification>",
            },
            { kind: "task-notification" },
        );
        for (const id of ["batch-completed", "batch-failed", "unconfirmed"]) {
            append({
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id,
                        name: "Bash",
                        input: { command: "echo background", run_in_background: true },
                    },
                ],
            });
            append(
                { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Command launched" }] },
                undefined,
                { backgroundTaskId: id, stdout: "", stderr: "" },
            );
        }
        append(
            {
                role: "user",
                content: [
                    { type: "text", text: notification("completed", "batch-completed") },
                    { type: "text", text: notification("failed", "batch-failed") },
                ],
            },
            { kind: "task-notification" },
        );
        await writeFile(join(project, `${nativeId}.jsonl`), `${records.join("\n")}\n`);
        peer.send(
            encodeSessionPreviewHistoryPageLoad({
                directory: ".",
                cursor: null,
                eventLimit: 200,
                kind: "session.preview-history.page.load",
                requestId: "background-history",
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
            expect(updates.filter((update) => update.sessionUpdate === "user_message_chunk")).toEqual([
                expect.objectContaining({ content: { type: "text", text: pasted } }),
            ]);
            for (const status of ["completed", "failed", "stopped", "unknown"]) {
                expect(updates).toContainEqual(
                    expect.objectContaining({
                        sessionUpdate: "tool_call",
                        toolCallId: `background-${status}`,
                        backgroundTask: { id: `task-${status}`, status },
                    }),
                );
            }
            expect(updates).toContainEqual(
                expect.objectContaining({
                    sessionUpdate: "tool_call",
                    title: "Background task",
                    backgroundTask: { id: "orphan", status: "stopped" },
                }),
            );
            expect(updates).toContainEqual(
                expect.objectContaining({
                    toolCallId: "unconfirmed",
                    backgroundTask: { id: "unconfirmed", status: "unknown" },
                }),
            );
            for (const status of ["completed", "failed"]) {
                expect(updates).toContainEqual(
                    expect.objectContaining({
                        toolCallId: `batch-${status}`,
                        backgroundTask: { id: `task-${status}`, status },
                    }),
                );
            }
            break;
        }
    });
});

test("Given Claude is running a background command, When two idle hours pass and the daemon later restarts, Then the task survives idle reclamation and its interrupted recovery updates the tool without a fake user message", async () => {
    const entered = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const server = createServer(async (request, response) => {
        entered.resolve(Number(request.url?.slice(1)));
        await release.promise;
        response.end("DONE");
    });
    await listen(server);
    try {
        const command = `${process.execPath} -e "require('node:http').get('http://127.0.0.1:${port(server)}/'+process.pid,r=>r.resume())"`;
        await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "BACKGROUND_RECOVERY_REPLY", {
            bash: { command, runInBackground: true },
        });
        await using agent = await ClaudeFixture.create(provider);
        const config = agent.environment["CLAUDE_CONFIG_DIR"];
        if (config === undefined) {
            throw new Error("Missing isolated Claude home");
        }
        await mkdir(config, { recursive: true });
        await writeFile(join(config, "settings.json"), JSON.stringify({ permissions: { ask: ["Bash"] } }));
        const timer = new IdleTimeoutTimer();
        vi.useFakeTimers({ now: new Date("2026-10-26T00:00:00Z"), toFake: ["Date"] });
        await withRealDaemon(
            new ClaudeCodeAgentSpecification(),
            agent.environment,
            async (peer) => {
                const sessionTarget = peer.target;
                const statuses: string[] = [];
                const users: string[] = [];
                let permissions = 0;
                const run = async (prompt: string) => {
                    const commandId = randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            kind: "session.prompt",
                            requestId: commandId,
                            commandId,
                            requestId: commandId,
                            target: sessionTarget,
                            attachments: [],
                            prompt,
                            disposition: SessionPromptDisposition.Append,
                        }),
                    );
                    for (;;) {
                        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                        if (event.type === "acp") {
                            if (
                                (event.payload.sessionUpdate === "tool_call" ||
                                    event.payload.sessionUpdate === "tool_call_update") &&
                                event.payload.backgroundTask !== undefined
                            ) {
                                statuses.push(event.payload.backgroundTask.status);
                            }
                            if (
                                event.payload.sessionUpdate === "user_message_chunk" &&
                                event.payload.content.type === "text"
                            ) {
                                users.push(event.payload.content.text);
                            }
                        }
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "session.permission.requested"
                        ) {
                            const request = event.payload.event;
                            const option = request.options.find((entry) => entry.kind === "allow_once");
                            if (option === undefined) {
                                throw new Error("Native command has no one-time approval option");
                            }
                            permissions++;
                            peer.send(
                                encodeSessionPermissionRespondCommand({
                                    kind: "session.permission.respond",
                                    requestId: crypto.randomUUID(),
                                    interactionId: request.interactionId,
                                    optionId: option.optionId,
                                    target: request.target,
                                    outcome: "selected",
                                }),
                            );
                        }
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                            throw new Error(JSON.stringify(event));
                        }
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === commandId
                        ) {
                            return;
                        }
                    }
                };
                await run(fakeProviderPrompts.successfulTool);
                expect(permissions).toBeGreaterThan(0);
                const pid = await entered.promise;
                expect(statuses).toContain("running");
                timer.advance(2 * 60 * 60 * 1_000);
                await run("Say hello");
                expect(() => process.kill(pid, 0)).not.toThrow();
                expect(statuses).not.toContain("stopped");
                await peer.restart();
                await run("Say hello after reconnecting");
                expect(statuses).toContain("stopped");
                expect(users.some((text) => text.includes("<task-notification>"))).toBe(false);
            },
            "embedded",
            undefined,
            timer,
        );
    } finally {
        vi.useRealTimers();
        release.resolve();
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
    }
});
