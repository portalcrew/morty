import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    type SessionLiveEvent,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

for (const harness of ["codex", "claude", "pi"] as const) {
    test(`Given real ${harness} is answering, When a client loads history before and after its reply, Then each snapshot identifies the live events it covers`, async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let holdResponse = false;
        const options = {
            beforeFirstText: async () => {
                if (holdResponse) {
                    entered.resolve();
                    await release.promise;
                }
            },
        };
        const answer = "SNAPSHOT_POSITION_REPLY";
        const provider =
            harness === "claude"
                ? await FakeAnthropicProvider.start("claude-sonnet-4-6", answer, options)
                : await FakeOpenAiProvider.start(harness === "pi" ? "gpt-4.1" : "morty-test-model", answer, options);
        const agent =
            provider instanceof FakeAnthropicProvider
                ? await ClaudeFixture.create(provider)
                : harness === "pi"
                  ? await PiFixture.create(provider)
                  : await CodexFixture.create(provider);
        const specification =
            harness === "claude"
                ? new ClaudeCodeAgentSpecification()
                : harness === "pi"
                  ? new PiAgentSpecification()
                  : new CodexAgentSpecification();
        try {
            await withRealDaemon(specification, agent.environment, async (peer) => {
                const sessionTarget = await prepareNewRealSession(peer, harness);
                holdResponse = true;
                const observed: SessionLiveEvent[] = [];
                const readPage = async (limit: number, cursor: string | null = null) => {
                    const requestId = randomUUID();
                    peer.send(
                        encodeSessionHistoryPageLoad({
                            kind: "session.live-history.v2.page.load",
                            requestId,
                            target: sessionTarget,
                            eventLimit: limit,
                            cursor,
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.event.v2") {
                            observed.push(...decodeSessionEventEnvelope(message).events);
                        }
                        if (kind === "session.operation.failed") {
                            throw new Error(message);
                        }
                        if (kind === "session.live-history.v2.page.loaded") {
                            const loaded = decodeSessionHistoryPageLoaded(message);
                            if (loaded.requestId === requestId) {
                                return loaded.events.events;
                            }
                        }
                    }
                };
                const commandId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        target: sessionTarget,
                        commandId,
                        requestId: commandId,
                        prompt: "Reply with the requested answer.",
                        attachments: [],
                        disposition: SessionPromptDisposition.Append,
                    }),
                );
                await entered.promise;
                const before = await readPage(1000);
                expect(before).toHaveProperty("throughPosition");
                const beforePosition = BigInt(before.throughPosition);
                expect(observed.every((event) => BigInt(event.position) <= beforePosition)).toBe(true);
                release.resolve();
                while (
                    !observed.some(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === commandId,
                    )
                ) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) === "session.event.v2") {
                        const events = decodeSessionEventEnvelope(message).events;
                        expect(
                            events.filter(
                                (event) =>
                                    event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed",
                            ),
                        ).toEqual([]);
                        observed.push(...events);
                    }
                }
                const after = await readPage(1000);
                expect(after).toHaveProperty("throughPosition");
                const afterPosition = BigInt(after.throughPosition);
                expect(afterPosition).toBeGreaterThan(beforePosition);
                expect(observed.every((event) => BigInt(event.position) <= afterPosition)).toBe(true);
                const replyEvents = observed.filter(
                    (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk",
                );
                expect(replyEvents.length).toBeGreaterThan(0);
                expect(replyEvents.every((event) => BigInt(event.position) > beforePosition)).toBe(true);
                expect(after.sessionGenerationId).toBe(before.sessionGenerationId);
                const text = after.events
                    .flatMap((event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                            ? [event.payload.content.text]
                            : [],
                    )
                    .join("");
                expect(text).toContain(answer);
                // The Agent may publish more after the turn (Claude titles the session at idle), so the
                // newest one-event page covers at least the reply snapshot and a live event it can name.
                const page = await readPage(1);
                const pagePosition = page.throughPosition;
                expect(BigInt(pagePosition)).toBeGreaterThanOrEqual(afterPosition);
                while (!observed.some((event) => event.position === pagePosition)) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) === "session.event.v2") {
                        observed.push(...decodeSessionEventEnvelope(message).events);
                    }
                }
                expect(page.events).toHaveLength(1);
                expect(page.nextCursor).not.toBeNull();
            });
        } finally {
            release.resolve();
            await agent[Symbol.asyncDispose]();
            await provider[Symbol.asyncDispose]();
        }
    });
}
