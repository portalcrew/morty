import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    encodeSessionCancelCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    encodeSessionPromptDispositionCommand,
    SESSION_EVENT_KIND,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

test("Given real Codex has accepted a steering prompt, When V2 recovery reloads the working Session, Then the steered user message remains visible", async () => {
    const activeEntered = Promise.withResolvers<void>();
    const releaseActive = Promise.withResolvers<void>();
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "STEERED_REPLY", {
        beforeFirstText: async () => {
            activeEntered.resolve();
            await releaseActive.promise;
        },
    });
    await using codex = await CodexFixture.create(provider);
    try {
        await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
            const activeCommandId = randomUUID();
            const steeringCommandId = randomUUID();
            const steeringPrompt = "Use the recovered steering requirement";
            peer.send(
                encodeSessionPromptCommand({
                    commandId: activeCommandId,
                    requestId: activeCommandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt: fakeProviderPrompts.twoTools,
                    target: peer.target,
                }),
            );
            await activeEntered.promise;
            peer.send(
                encodeSessionPromptCommand({
                    commandId: steeringCommandId,
                    requestId: steeringCommandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt: steeringPrompt,
                    target: peer.target,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (
                    decodeMessageKind(message) === SESSION_EVENT_KIND &&
                    decodeSessionEventEnvelope(message).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                    )
                ) {
                    break;
                }
            }
            peer.send(
                encodeSessionPromptDispositionCommand({
                    commandId: steeringCommandId,
                    disposition: SessionPromptDisposition.Steer,
                    kind: "session.prompt.disposition",
                    requestId: crypto.randomUUID(),
                    target: peer.target,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                if (
                    decodeSessionEventEnvelope(message).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === steeringCommandId,
                    )
                ) {
                    break;
                }
            }
            // Native acceptance must arrive while consumption is still held at the model boundary.
            releaseActive.resolve();
            let steeringEventId: string | undefined;
            let steeringMessageId: string | undefined;
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                const requested = decodeSessionEventEnvelope(message).events.find(
                    (event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "user_message_chunk" &&
                        event.payload.content.type === "text" &&
                        event.payload.content.text === steeringPrompt,
                );
                if (requested !== undefined) {
                    steeringEventId = requested.eventId;
                    if (requested.type === "acp" && requested.payload.sessionUpdate === "user_message_chunk") {
                        steeringMessageId = requested.payload.messageId ?? undefined;
                    }
                    break;
                }
            }
            const requestId = randomUUID();
            peer.send(
                encodeSessionHistoryPageLoad({
                    cursor: null,
                    eventLimit: 50,
                    kind: "session.live-history.v2.page.load",
                    requestId,
                    target: peer.target,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                    continue;
                }
                const recovered = decodeSessionHistoryPageLoaded(message);
                if (recovered.requestId !== requestId) {
                    continue;
                }
                expect(
                    recovered.events.events.events.some(
                        (event) =>
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "user_message_chunk" &&
                            event.payload.content.type === "text" &&
                            event.payload.content.text === steeringPrompt &&
                            event.eventId === steeringEventId &&
                            event.payload.messageId === steeringMessageId,
                    ),
                ).toBe(true);
                expect(recovered.events.events.events).toContainEqual(
                    expect.objectContaining({
                        type: "lifecycle-metadata",
                        payload: expect.objectContaining({
                            kind: "prompt.requested",
                            commandId: steeringCommandId,
                            disposition: "steer",
                        }),
                    }),
                );
                break;
            }
        });
    } finally {
        releaseActive.resolve();
    }
});

test("Given real Codex advances between repeated prompts, When V2 recovery paginates the active stream, Then both user messages remain distinct and projected events stay ordered", async () => {
    const activeEntered = Promise.withResolvers<void>();
    const queuedEntered = Promise.withResolvers<void>();
    const releaseActive = Promise.withResolvers<void>();
    const releaseQueued = Promise.withResolvers<void>();
    let responseNumber = 0;
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "BOUNDARY_REPLY", {
        beforeFirstText: async () => {
            responseNumber += 1;
            if (responseNumber === 1) {
                activeEntered.resolve();
                await releaseActive.promise;
            } else if (responseNumber === 2) {
                queuedEntered.resolve();
                await releaseQueued.promise;
            }
        },
    });
    await using codex = await CodexFixture.create(provider);
    try {
        await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
            const active = randomUUID();
            const queued = randomUUID();
            const repeatedPrompt = fakeProviderPrompts.twoTools;
            const prompt = (commandId: string, text = `Reply to ${commandId}`): void =>
                peer.send(
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: commandId,
                        disposition: SessionPromptDisposition.Append,
                        attachments: [],
                        kind: "session.prompt",
                        prompt: text,
                        target: peer.target,
                    }),
                );

            prompt(active, repeatedPrompt);
            await activeEntered.promise;
            prompt(queued, repeatedPrompt);
            for (;;) {
                const message = await peer.nextMessage();
                if (
                    decodeMessageKind(message) === SESSION_EVENT_KIND &&
                    decodeSessionEventEnvelope(message).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                    )
                ) {
                    break;
                }
            }

            releaseActive.resolve();
            await queuedEntered.promise;
            const requestId = randomUUID();
            peer.send(
                encodeSessionHistoryPageLoad({
                    cursor: null,
                    eventLimit: 1,
                    kind: "session.live-history.v2.page.load",
                    requestId,
                    target: peer.target,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                    continue;
                }
                const result = decodeSessionHistoryPageLoaded(message);
                if (result.requestId !== requestId) {
                    continue;
                }
                expect(result.events.queuedPromptRequests).toEqual([]);
                const sessionGenerationId = result.events.events.sessionGenerationId;
                const historyEvents = [...result.events.events.events];
                let cursor = result.events.events.nextCursor;
                while (cursor !== null) {
                    const olderRequestId = randomUUID();
                    peer.send(
                        encodeSessionHistoryPageLoad({
                            cursor,
                            eventLimit: 1,
                            kind: "session.live-history.v2.page.load",
                            requestId: olderRequestId,
                            target: peer.target,
                        }),
                    );
                    for (;;) {
                        const olderMessage = await peer.nextMessage();
                        if (decodeMessageKind(olderMessage) !== "session.live-history.v2.page.loaded") {
                            continue;
                        }
                        const older = decodeSessionHistoryPageLoaded(olderMessage);
                        if (older.requestId !== olderRequestId) {
                            continue;
                        }
                        expect(older.events.events.sessionGenerationId).toBe(sessionGenerationId);
                        historyEvents.unshift(...older.events.events.events);
                        cursor = older.events.events.nextCursor;
                        break;
                    }
                }
                const userMessages = historyEvents.filter(
                    (event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "user_message_chunk" &&
                        event.payload.content.type === "text" &&
                        event.payload.content.text === repeatedPrompt,
                );
                expect(userMessages).toHaveLength(2);
                expect(new Set(userMessages.map((event) => event.eventId)).size).toBe(2);
                for (const event of userMessages) {
                    expect(event).toMatchObject({ payload: { messageId: expect.any(String) } });
                    expect(event.type === "acp" && "messageId" in event.payload && event.payload.messageId).not.toBe(
                        event.eventId,
                    );
                }
                expect(
                    historyEvents.filter(
                        (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.requested",
                    ),
                ).toHaveLength(2);
                expect(historyEvents.map((event) => event.eventId)).toEqual(
                    historyEvents.map((event) => event.eventId).toSorted(),
                );
                expect(historyEvents.every((event) => event.eventId.startsWith(`event-${sessionGenerationId}-`))).toBe(
                    true,
                );
                break;
            }
            releaseQueued.resolve();
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.completed" &&
                    event.payload.commandId === queued
                ) {
                    expect(event.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
        });
    } finally {
        releaseActive.resolve();
        releaseQueued.resolve();
    }
});

test("Given real Codex with an active turn, When three follow-ups are accepted and the middle one is cancelled, Then the remaining prompts execute in FIFO order without depending on the original turn", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "FIFO_REPLY", {
        beforeFirstText: async () => {
            entered.resolve();
            await release.promise;
        },
    });
    await using codex = await CodexFixture.create(provider);
    try {
        await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
            const active = randomUUID();
            const first = randomUUID();
            const cancelled = randomUUID();
            const last = randomUUID();
            const sendPrompt = (commandId: string): void =>
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        commandId,
                        requestId: commandId,
                        target: peer.target,
                        attachments: [],
                        prompt: `Reply to ${commandId}`,
                        disposition: SessionPromptDisposition.Append,
                    }),
                );
            sendPrompt(active);
            await entered.promise;
            // While the target Turn holds the Session, each queued submission is
            // admitted in submission order and acknowledged by its own V2 queue
            // change before the next one enters the queue.
            for (const id of [first, cancelled, last]) {
                sendPrompt(id);
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    if (
                        decodeSessionEventEnvelope(message).events.some(
                            (event) =>
                                event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                        )
                    ) {
                        break;
                    }
                }
            }
            peer.send(
                encodeSessionHistoryPageLoad({
                    cursor: null,
                    eventLimit: 25,
                    kind: "session.live-history.v2.page.load",
                    requestId: randomUUID(),
                    target: peer.target,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                    continue;
                }
                const recovered = decodeSessionHistoryPageLoaded(message).events;
                expect(recovered.queuedPromptRequests).toEqual([
                    expect.objectContaining({ commandId: first }),
                    expect.objectContaining({ commandId: cancelled }),
                    expect.objectContaining({ commandId: last }),
                ]);
                break;
            }
            peer.send(
                encodeSessionCancelCommand({
                    kind: "session.cancel",
                    requestId: crypto.randomUUID(),
                    target: peer.target,
                    commandId: cancelled,
                }),
            );
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.commandId).toBe(cancelled);
                    expect(event.payload.stopReason).toBe("cancelled");
                    break;
                }
            }
            release.resolve();
            const started: string[] = [];
            const completed: string[] = [];
            const replies = new Map<string, string>();
            while (completed.length < 3) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                for (const event of decodeSessionEventEnvelope(message).events) {
                    if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        throw new Error(JSON.stringify(event));
                    }
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.started") {
                        started.push(event.payload.commandId);
                    }
                    if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        const current = started.at(-1) ?? active;
                        replies.set(current, `${replies.get(current) ?? ""}${event.payload.content.text}`);
                    }
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        expect(event.payload.stopReason).toBe("end_turn");
                        completed.push(event.payload.commandId);
                    }
                }
            }
            expect(started).toEqual([first, last]);
            expect(completed).toEqual([active, first, last]);
            for (const id of completed) {
                expect(replies.get(id)).toContain("FIFO_REPLY");
            }
            // With nothing left running, a later message runs at once instead of entering the queue.
            const late = randomUUID();
            sendPrompt(late);
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.event.v2") {
                    continue;
                }
                const events = decodeSessionEventEnvelope(message).events;
                const failure = events.find(
                    (event) =>
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start"),
                );
                if (failure !== undefined) {
                    throw new Error(JSON.stringify(failure));
                }
                const completion = events.find(
                    (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
                );
                if (completion?.type === "lifecycle-metadata" && completion.payload.kind === "prompt.completed") {
                    expect(completion.payload.commandId).toBe(late);
                    expect(completion.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
        });
    } finally {
        release.resolve();
    }
});
