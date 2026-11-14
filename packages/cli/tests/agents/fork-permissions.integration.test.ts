import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { watch } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    encodeNativeSessionCommand,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { nextNativeSessionResult, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

const toolPrompt = "Run the permission verification command";
const command = `node -e "require('node:fs').writeFileSync('fork-permission.txt', 'approved')"`;

test.each(["codex", "claude"] as const)(
    "Given a real %s Session with explicit approval, When it is forked before and after restart, Then each child retains approval and enforces the user's decision",
    async (harness) => {
        await using provider =
            harness === "codex"
                ? await FakeOpenAiProvider.start("morty-test-model", "FORK_PERMISSION_DONE", {
                      toolPrompt,
                      toolSequence: [
                          {
                              name: "exec",
                              input: `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)}, sandbox_permissions: "require_escalated", justification: "Verify inherited Fork approval" }); text(result.output);`,
                          },
                      ],
                  })
                : await FakeAnthropicProvider.start("claude-sonnet-4-6", "FORK_PERMISSION_DONE", {
                      toolPrompt,
                      bash: { command, runInBackground: false },
                  });
        await using agent =
            provider instanceof FakeOpenAiProvider
                ? await CodexFixture.create(provider)
                : await ClaudeFixture.create(provider);
        if (harness === "claude") {
            const config = agent.environment["CLAUDE_CONFIG_DIR"];
            if (config === undefined) {
                throw new Error("Missing Claude fixture home");
            }
            await mkdir(config, { recursive: true });
            await writeFile(
                join(config, "settings.json"),
                JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
            );
        }
        const mode = harness === "codex" ? "read-only" : "default";
        await withRealDaemon(
            harness === "codex" ? new CodexAgentSpecification() : new ClaudeCodeAgentSpecification(),
            agent.environment,
            async (peer) => {
                const identity = {
                    harness,
                    directory: ".",
                };
                const prompt = (sessionTarget: RealDaemonPeer["target"], text: string, selectMode = false): void => {
                    const commandId = randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            kind: "session.prompt",
                            target: sessionTarget,
                            commandId,
                            requestId: commandId,
                            disposition: SessionPromptDisposition.Append,
                            attachments: [],
                            prompt: text,
                            ...(selectMode
                                ? {
                                      sessionConfigurations: [{ configId: "mode", type: "select", value: mode }],
                                  }
                                : {}),
                        }),
                    );
                };
                const ready = async (sessionTarget: RealDaemonPeer["target"]): Promise<void> => {
                    const requestId = randomUUID();
                    peer.send(
                        encodeSessionPrepareCommand({
                            kind: "session.prepare",
                            requestId,
                            target: sessionTarget,
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.operation.failed") {
                            throw new Error(message);
                        }
                        if (kind !== "session.ready") {
                            continue;
                        }
                        const result = decodeSessionReadyEvent(message);
                        if (result.requestId !== requestId) {
                            continue;
                        }
                        expect(result.configOptions).toContainEqual(
                            expect.objectContaining({ id: "mode", currentValue: mode }),
                        );
                        return;
                    }
                };
                prompt(peer.target, "Remember this source conversation", true);
                expect(await finish(peer, "reject_once")).toBe(0);
                await ready(peer.target);
                for (const decision of ["reject_once", "allow_once"] as const) {
                    if (decision === "allow_once") {
                        await peer.restart();
                    }
                    const source = await nativeSource(peer, harness, agent.environment["CLAUDE_CONFIG_DIR"]);
                    const requestId = randomUUID();
                    peer.send(
                        encodeNativeSessionCommand({
                            ...identity,
                            kind: "native.session.request",
                            requestId,
                            action: "fork",
                            sessionId: source.sessionId,
                        }),
                    );
                    const fork = await nextNativeSessionResult(peer, requestId);
                    if (fork.action !== "fork") {
                        throw new Error("Expected independent Fork");
                    }
                    expect(fork.ready.configOptions).toContainEqual(
                        expect.objectContaining({ id: "mode", currentValue: mode }),
                    );
                    expect(fork.target.sessionId).not.toBe(peer.target.sessionId);
                    if (decision === "allow_once") {
                        await peer.restart();
                    }
                    await ready(fork.target);
                    prompt(fork.target, toolPrompt);
                    expect(await finish(peer, decision)).toBe(1);
                    const file = join(peer.workspace, "fork-permission.txt");
                    if (decision === "allow_once") {
                        expect(await readFile(file, "utf8")).toBe("approved");
                        await rm(file);
                    } else {
                        await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
                    }
                    await ready(peer.target);
                }
            },
        );
    },
);

async function nativeSource(peer: RealDaemonPeer, harness: string, configDirectory: string | undefined) {
    // Claude flushes native history after live completion. Retry the public list
    // only when its isolated native home changes; no sleeps or timing assumptions.
    type NativeWrite = { readonly kind: "changed" } | { readonly kind: "failed"; readonly cause: Error };
    let changed = Promise.withResolvers<NativeWrite>();
    const watcher =
        configDirectory === undefined
            ? undefined
            : watch(configDirectory, { recursive: true }, () => changed.resolve({ kind: "changed" }));
    watcher?.on("error", (cause) => changed.resolve({ kind: "failed", cause }));
    using _abort = addAbortListener(peer.signal, () => changed.resolve({ kind: "changed" }));
    try {
        for (;;) {
            peer.signal.throwIfAborted();
            const notification = changed.promise;
            const requestId = randomUUID();
            peer.send(
                encodeNativeSessionCommand({
                    harness,
                    directory: ".",
                    kind: "native.session.request",
                    requestId,
                    action: "list",
                    cursor: null,
                }),
            );
            const listed = await nextNativeSessionResult(peer, requestId);
            if (listed.action !== "list") {
                throw new Error("Expected native session list");
            }
            const source = listed.entries.find((entry) => entry.sessionId === peer.target.sessionId);
            if (source !== undefined) {
                return { ...source };
            }
            if (watcher === undefined) {
                throw new Error("Missing source Session");
            }
            const event = await notification;
            if (event.kind === "failed") {
                throw event.cause;
            }
            changed = Promise.withResolvers<NativeWrite>();
        }
    } finally {
        watcher?.close();
    }
}

async function finish(peer: RealDaemonPeer, decision: "allow_once" | "reject_once"): Promise<number> {
    let approvals = 0;
    let text = "";
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
            approvals++;
            const permission = event.payload.event;
            const choice = permission.options.find((option) => option.kind === decision);
            if (choice === undefined) {
                throw new Error(`Missing ${decision} approval choice`);
            }
            peer.send(
                encodeSessionPermissionRespondCommand({
                    kind: "session.permission.respond",
                    requestId: crypto.randomUUID(),
                    target: event.target,
                    interactionId: permission.interactionId,
                    optionId: choice.optionId,
                    outcome: "selected",
                }),
            );
        } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        } else if (
            event.type === "acp" &&
            event.payload.sessionUpdate === "agent_message_chunk" &&
            event.payload.content.type === "text"
        ) {
            text += event.payload.content.text;
        } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
            expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
            expect(text).toContain("FORK_PERMISSION_DONE");
            return approvals;
        }
    }
}
