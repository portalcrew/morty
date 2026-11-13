import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { writeCodexFaultLauncher } from "../support/agents/codex-process-fault.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given an existing real Codex conversation, When the process exits or its transport is corrupted, Then the daemon reports a typed failure and can continue that conversation", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "RECOVERED_REPLY");
    await using codex = await CodexFixture.create(provider);
    const directory = await mkdtemp(join(tmpdir(), "morty-codex-fault-"));
    const launcher = join(directory, "codex.mjs");
    const faultPath = join(directory, "fault");
    try {
        await writeCodexFaultLauncher(codex, launcher, faultPath);
        await withRealDaemon(
            new CodexAgentSpecification(),
            { ...codex.environment, MORTY_CODEX_PATH: launcher },
            async (peer) => {
                const run = async () => {
                    const commandId = randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            kind: "session.prompt",
                            commandId,
                            requestId: commandId,
                            target: peer.target,
                            attachments: [],
                            prompt: "Continue the conversation",
                            disposition: SessionPromptDisposition.Append,
                        }),
                    );
                    let text = "";
                    for (;;) {
                        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                        if (
                            event.type === "lifecycle-metadata" &&
                            "commandId" in event.payload &&
                            event.payload.commandId !== commandId
                        ) {
                            continue;
                        }
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            text += event.payload.content.text;
                        }
                        if (
                            (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") ||
                            (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed")
                        ) {
                            return { event, text };
                        }
                    }
                };
                expect(await run()).toMatchObject({
                    event: { payload: { kind: "prompt.completed" } },
                    text: expect.stringContaining("RECOVERED_REPLY"),
                });
                for (const fault of ["before-ack", "after-ack", "invalid-frame"]) {
                    await writeFile(faultPath, fault);
                    const failed = await run();
                    expect(failed.event).toMatchObject({
                        payload: {
                            kind: "prompt.failed",
                            code:
                                fault === "invalid-frame"
                                    ? "codex_app_server_protocol_error"
                                    : "codex_app_server_exited",
                        },
                    });
                    expect(await run()).toMatchObject({
                        event: { payload: { kind: "prompt.completed" } },
                        text: expect.stringContaining("RECOVERED_REPLY"),
                    });
                }
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("Given a real Codex conversation in Plan mode, When its process recovers before Go, Then the resumed settings still show Plan mode", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "PLAN_RECOVERY_REPLY");
    await using codex = await CodexFixture.create(provider, { configuredModel: provider.model });
    const directory = await mkdtemp(join(tmpdir(), "morty-codex-plan-recovery-"));
    const launcher = join(directory, "codex.mjs");
    const faultPath = join(directory, "fault");
    try {
        await writeCodexFaultLauncher(codex, launcher, faultPath);
        await withRealDaemon(
            new CodexAgentSpecification(),
            { ...codex.environment, MORTY_CODEX_PATH: launcher },
            async (peer) => {
                const run = async (plan: boolean) => {
                    const commandId = randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            kind: "session.prompt",
                            commandId,
                            requestId: commandId,
                            target: peer.target,
                            attachments: [],
                            prompt: plan ? "Give me a plan" : "Go.",
                            disposition: SessionPromptDisposition.Append,
                            ...(plan
                                ? {
                                      sessionConfigurations: [
                                          {
                                              configId: "collaboration_mode",
                                              type: "select" as const,
                                              value: "plan",
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    );
                    for (;;) {
                        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                        if (
                            event.type === "lifecycle-metadata" &&
                            "commandId" in event.payload &&
                            event.payload.commandId !== commandId
                        ) {
                            continue;
                        }
                        if (
                            (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") ||
                            (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed")
                        ) {
                            return event;
                        }
                    }
                };

                expect(await run(true)).toMatchObject({ payload: { kind: "prompt.completed" } });
                await writeFile(faultPath, "before-ack");
                expect(await run(false)).toMatchObject({ payload: { kind: "prompt.failed" } });
                expect(await run(false)).toMatchObject({ payload: { kind: "prompt.completed" } });

                const requestId = randomUUID();
                peer.send(
                    encodeSessionPrepareCommand({
                        kind: "session.prepare",
                        requestId,
                        target: peer.target,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "session.ready") {
                        continue;
                    }
                    const ready = decodeSessionReadyEvent(message);
                    if (ready.requestId !== requestId) {
                        continue;
                    }
                    expect(ready.configOptions.find((option) => option.id === "collaboration_mode")).toMatchObject({
                        currentValue: "plan",
                    });
                    break;
                }
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
