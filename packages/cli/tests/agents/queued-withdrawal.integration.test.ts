import { randomUUID } from "node:crypto";
import { decodeSessionLiveEvent, encodeSessionPromptCommand } from "@morty-build/client/protocol";
import { expect, test, vi } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.each(["pi", "claude", "codex"] as const)(
    "Given real %s is replying, When a queued message is withdrawn and revised, Then only the revision executes and the original reply completes",
    async (harness) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const beforeFirstText = async (signal: AbortSignal): Promise<void> => {
            entered.resolve();
            const aborted = Promise.withResolvers<void>();
            const abort = () => aborted.resolve();
            signal.addEventListener("abort", abort, { once: true });
            try {
                if (!signal.aborted) {
                    await Promise.race([release.promise, aborted.promise]);
                }
            } finally {
                signal.removeEventListener("abort", abort);
            }
        };
        const scenario = async (peer: RealDaemonPeer): Promise<void> => {
            const active = randomUUID();
            const queued = randomUUID();
            const revised = randomUUID();
            const started: string[] = [];
            const completed = new Map<string, string>();
            const userText: string[] = [];
            let replies = "";
            const prompt = (commandId: string, text: string) =>
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        requestId: commandId,
                        commandId,
                        requestId: commandId,
                        target: peer.target,
                        attachments: [],
                        disposition: "append",
                        prompt: text,
                    }),
                );
            const next = async () => {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata") {
                    if (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start") {
                        throw new Error(JSON.stringify(event.payload));
                    }
                    if (event.payload.kind === "prompt.started") {
                        started.push(event.payload.commandId);
                    }
                    if (event.payload.kind === "prompt.completed") {
                        completed.set(event.payload.commandId, event.payload.stopReason);
                    }
                    if (event.payload.kind === "session.permission.requested") {
                        const request = event.payload.event;
                        const option = request.options.find((candidate) => candidate.kind === "allow_once");
                        if (option === undefined) {
                            throw new Error("Expected a tool permission option");
                        }
                        peer.send(
                            JSON.stringify({
                                kind: "session.permission.respond",
                                requestId: crypto.randomUUID(),
                                target: peer.target,
                                interactionId: request.interactionId,
                                outcome: "selected",
                                optionId: option.optionId,
                            }),
                        );
                    }
                } else if (
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "user_message_chunk" ||
                        event.payload.sessionUpdate === "agent_message_chunk") &&
                    event.payload.content.type === "text"
                ) {
                    if (event.payload.sessionUpdate === "user_message_chunk") {
                        userText.push(event.payload.content.text);
                    } else {
                        replies += event.payload.content.text;
                    }
                }
                return event;
            };
            prompt(active, "Start the original reply");
            await entered.promise;
            prompt(queued, "OLD_QUEUED_INSTRUCTION");
            for (;;) {
                const event = await next();
                if (event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed") {
                    break;
                }
            }
            peer.send(
                JSON.stringify({
                    kind: "session.cancel-before-start",
                    requestId: crypto.randomUUID(),
                    commandId: queued,
                    target: peer.target,
                }),
            );
            while (!completed.has(queued)) {
                await next();
            }
            expect(completed.get(queued)).toBe("cancelled");
            expect(completed.has(active)).toBe(false);
            prompt(revised, "REVISED_QUEUED_INSTRUCTION");
            release.resolve();
            while (!completed.has(revised)) {
                await next();
            }
            expect(completed.get(active)).toBe("end_turn");
            expect(completed.get(revised)).toBe("end_turn");
            expect(started).toEqual([active, revised]);
            expect(userText.join("\n")).toContain("REVISED_QUEUED_INSTRUCTION");
            expect(userText.join("\n")).not.toContain("OLD_QUEUED_INSTRUCTION");
            expect(replies).toContain("QUEUE_WITHDRAWAL_REPLY");
        };
        try {
            if (harness === "claude") {
                await using provider = await FakeAnthropicProvider.start(
                    "claude-sonnet-4-6",
                    "QUEUE_WITHDRAWAL_REPLY",
                    { beforeFirstText: async (_scenario, signal) => beforeFirstText(signal) },
                );
                await using agent = await ClaudeFixture.create(provider);
                await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, scenario);
            } else {
                await using provider = await FakeOpenAiProvider.start(
                    harness === "pi" ? "gpt-4.1" : "morty-test-model",
                    "QUEUE_WITHDRAWAL_REPLY",
                    { beforeFirstText },
                );
                if (harness === "pi") {
                    await using agent = await PiFixture.create(provider);
                    await withRealDaemon(new PiAgentSpecification(), agent.environment, scenario);
                } else {
                    await using agent = await CodexFixture.create(provider);
                    await withRealDaemon(new CodexAgentSpecification(), agent.environment, scenario);
                }
            }
        } finally {
            release.resolve();
            vi.useRealTimers();
        }
    },
    90_000,
);
