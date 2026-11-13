import { randomUUID } from "node:crypto";
import { copyFile, mkdir, symlink } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import {
    decodeSessionLiveEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

test("Given native Claude is installed outside PATH, When two prompts execute through the daemon, Then discovery finds it and both streamed replies arrive", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "REAL_CLAUDE_REPLY");
    await using agent = await ClaudeFixture.create(provider);
    const home = agent.environment["HOME"];
    if (home === undefined) {
        throw new Error("The Claude fixture home is unavailable");
    }
    const nativeDirectory = join(home, ".local", "bin");
    await mkdir(nativeDirectory, { recursive: true });
    if (process.platform === "win32") {
        await copyFile(agent.executable, join(nativeDirectory, "claude.exe"));
    } else {
        await symlink(agent.executable, join(nativeDirectory, "claude"));
    }
    const environment = Object.fromEntries(
        Object.entries(agent.environment).filter(([name]) => name !== "MORTY_CLAUDE_PATH"),
    );
    environment["PATH"] = "/usr/bin:/bin";
    if (process.platform === "win32") {
        const systemRoot = process.env["SystemRoot"];
        if (systemRoot === undefined) {
            throw new Error("Windows system directory is unavailable");
        }
        environment["USERPROFILE"] = home;
        environment["PATH"] = [
            dirname(process.execPath),
            join(systemRoot, "System32"),
            join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
        ].join(delimiter);
    }
    await withRealDaemon(new ClaudeCodeAgentSpecification(), environment, async (peer) => {
        for (const turn of [0, 1]) {
            const prompt =
                turn === 0 ? fakeProviderPrompts.successfulTool : "Continue the conversation with another reply";
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
            let text = "";
            let toolSucceeded = false;
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                    const option = event.payload.event.options.find((entry) => entry.kind === "allow_once");
                    if (option === undefined) {
                        throw new Error("No one-time tool permission option");
                    }
                    peer.send(
                        encodeSessionPermissionRespondCommand({
                            kind: "session.permission.respond",
                            requestId: crypto.randomUUID(),
                            target: peer.target,
                            interactionId: event.payload.event.interactionId,
                            optionId: option.optionId,
                            outcome: "selected",
                        }),
                    );
                } else if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                } else if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "tool_call_update" &&
                    event.payload.status === "completed"
                ) {
                    const workspaceTail = `${basename(dirname(peer.workspace))}/${basename(peer.workspace)}`;
                    expect(JSON.stringify(event.payload.content).replaceAll("\\", "/")).toContain(workspaceTail);
                    toolSucceeded = true;
                } else if (
                    event.type === "lifecycle-metadata" &&
                    (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                ) {
                    throw new Error(JSON.stringify(event));
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.commandId).toBe(commandId);
                    expect(event.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
            expect(text).toContain(provider.responseFor(prompt));
            if (turn === 0) {
                expect(toolSucceeded).toBe(true);
            }
        }
    });
});

test.skipIf(process.platform !== "darwin")(
    "Given Claude Code receives a transient provider error, When its production adapter retries, Then the successful reply reaches the client without failing the turn",
    async () => {
        await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "CLAUDE_RECOVERED", {
            disconnectsBeforeSuccess: 1,
        });
        await using agent = await ClaudeFixture.create(provider);
        await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "Recover after a transient overload",
                    target: peer.target,
                }),
            );
            let text = "";
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                } else if (
                    event.type === "lifecycle-metadata" &&
                    (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                ) {
                    throw new Error(JSON.stringify(event));
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    break;
                }
            }
            expect(text).toContain("CLAUDE_RECOVERED");
        });
    },
);
