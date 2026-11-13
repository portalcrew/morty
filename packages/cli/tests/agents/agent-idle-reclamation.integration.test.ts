import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionLiveEvent,
    encodeNativeSessionCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { waitForAgentFile, writeObservedAgentLauncher } from "../support/agents/observed-process.ts";
import { type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { IdleTimeoutTimer } from "../support/idle-timeout-timer.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

afterEach(() => vi.useRealTimers());

test.each(["codex", "claude"] as const)(
    "Given a real %s conversation, When it is reclaimed after two idle hours, Then its process exits and its original history continues in a new process",
    async (harness) => {
        await using provider =
            harness === "codex"
                ? await FakeOpenAiProvider.start("morty-test-model", "IDLE_RECOVERY_REPLY")
                : await FakeAnthropicProvider.start("claude-sonnet-4-6", "IDLE_RECOVERY_REPLY");
        await using agent =
            provider instanceof FakeOpenAiProvider
                ? await CodexFixture.create(provider)
                : await ClaudeFixture.create(provider);
        const directory = await mkdtemp(join(tmpdir(), `morty-idle-real-${harness}-`));
        const processes = join(directory, "processes");
        const launcher = join(directory, "agent.mjs");
        await mkdir(processes);
        await writeObservedAgentLauncher(agent.executable, launcher, processes);
        const timer = new IdleTimeoutTimer();
        vi.useFakeTimers({ now: new Date("2026-10-22T00:00:00Z"), toFake: ["Date"] });
        try {
            await withRealDaemon(
                harness === "codex" ? new CodexAgentSpecification() : new ClaudeCodeAgentSpecification(),
                { ...agent.environment, [harness === "codex" ? "MORTY_CODEX_PATH" : "MORTY_CLAUDE_PATH"]: launcher },
                async (peer) => {
                    const sessionTarget = peer.target;
                    await prompt(peer, sessionTarget, "Remember ORIGINAL_BEFORE_IDLE and reply without tools");
                    const retained = (await readdir(processes)).filter((name) => name.endsWith(".process"));
                    expect(retained).toHaveLength(1);
                    const original = retained[0];
                    if (original === undefined) {
                        throw new Error("The real Agent process was not retained");
                    }
                    timer.advance(2 * 60 * 60 * 1_000 - 1);
                    expect(existsSync(join(processes, original))).toBe(true);
                    const exited = waitForAgentFile(join(processes, original), false);
                    timer.advance(1);
                    await exited;
                    // Browsing re-establishes the workspace reader independently of execution.
                    peer.send(
                        encodeNativeSessionCommand({
                            kind: "native.session.request",
                            action: "list",
                            requestId: crypto.randomUUID(),
                            harness,
                            directory: ".",
                            cursor: null,
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.operation.failed" || kind === "session.close.notice") {
                            throw new Error(message);
                        }
                        if (kind === "native.session.result") {
                            expect(message).toContain(sessionTarget.sessionId);
                            break;
                        }
                    }
                    const readers = (await readdir(processes)).filter((name) => name.endsWith(".process"));
                    await prompt(peer, sessionTarget, "Continue AFTER_IDLE_RECOVERY without tools");
                    const resumed = (await readdir(processes)).filter((name) => name.endsWith(".process"));
                    expect(resumed).toHaveLength(readers.length + 1);
                    expect(resumed).toEqual(expect.arrayContaining(readers));
                    expect(resumed).not.toContain(original);
                    peer.send(
                        encodeSessionHistoryPageLoad({
                            kind: "session.live-history.v2.page.load",
                            requestId: crypto.randomUUID(),
                            target: sessionTarget,
                            cursor: null,
                            eventLimit: 200,
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.operation.failed" || kind === "session.close.notice") {
                            throw new Error(message);
                        }
                        if (kind === "session.live-history.v2.page.loaded") {
                            expect(message).toContain("ORIGINAL_BEFORE_IDLE");
                            expect(message).toContain("AFTER_IDLE_RECOVERY");
                            break;
                        }
                    }
                    // Both the query reader and the replacement execution must be reclaimable.
                    const exits = resumed.map((name) => waitForAgentFile(join(processes, name), false));
                    timer.advance(2 * 60 * 60 * 1_000);
                    await Promise.all(exits);
                    expect((await readdir(processes)).filter((name) => name.endsWith(".process"))).toEqual([]);
                },
                "embedded",
                undefined,
                timer,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

async function prompt(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"], text: string): Promise<void> {
    const commandId = crypto.randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            kind: "session.prompt",
            requestId: commandId,
            commandId,
            requestId: commandId,
            target: sessionTarget,
            attachments: [],
            prompt: text,
            disposition: SessionPromptDisposition.Append,
        }),
    );
    let output = "";
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (
            event.type === "acp" &&
            event.payload.sessionUpdate === "agent_message_chunk" &&
            event.payload.content.type === "text"
        ) {
            output += event.payload.content.text;
        }
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        }
        if (
            event.type === "lifecycle-metadata" &&
            event.payload.kind === "prompt.completed" &&
            event.payload.commandId === commandId
        ) {
            expect(event.payload.stopReason).toBe("end_turn");
            expect(output).toContain("IDLE_RECOVERY_REPLY");
            return;
        }
    }
}
