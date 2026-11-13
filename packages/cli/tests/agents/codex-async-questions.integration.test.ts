import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    decodeSessionPreviewHistoryPageLoaded,
    encodeNativeSessionCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPreviewHistoryPageLoad,
    encodeSessionPromptCommand,
    type SessionEventPayload,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a real Codex model that asks the user a question while it keeps working, When the turn runs, the conversation is reopened, and the saved thread is previewed, Then its message carries the question and its suggested answers each time", async () => {
    const prompt = "Ask which way to go before continuing";
    const question = "Append the sections to the existing page?";
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "Continuing with the code.", {
        toolPrompt: prompt,
        toolSequence: [
            {
                name: "request_user_input_async",
                input: JSON.stringify({ questions: [{ title: question, options: ["Update the page", "Not now"] }] }),
            },
        ],
    });
    await using codex = await CodexFixture.create(provider, {
        configuredModel: "morty-test-model",
        modelTools: ["send_user_message_async"],
    });
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                requestId: commandId,
                commandId,
                requestId: commandId,
                target: peer.target,
                attachments: [],
                prompt,
                disposition: SessionPromptDisposition.Append,
            }),
        );
        const live: SessionEventPayload[] = [];
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            live.push(event);
            if (event.type !== "lifecycle-metadata") {
                continue;
            }
            if (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start") {
                throw new Error(JSON.stringify(event));
            }
            if (event.payload.kind === "prompt.completed" && event.payload.commandId === commandId) {
                break;
            }
        }
        const asked = [
            {
                text: `${question}\n- Update the page\n- Not now`,
                questions: [{ question, options: ["Update the page", "Not now"] }],
            },
        ];
        expect.soft(questionMessages(live)).toEqual(asked);
        await peer.restart();
        peer.send(
            encodeSessionHistoryPageLoad({
                kind: "session.live-history.v2.page.load",
                requestId: randomUUID(),
                target: peer.target,
                cursor: null,
                eventLimit: 100,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind === "session.live-history.v2.page.loaded") {
                expect(questionMessages(decodeSessionHistoryPageLoaded(message).events.events.events)).toEqual(asked);
                break;
            }
        }
        // Previewing the saved Codex thread replays it from Codex itself.
        const identity = {
            harness: "codex",
            directory: ".",
        } as const;
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                kind: "native.session.request",
                requestId: "list",
                action: "list",
                cursor: null,
            }),
        );
        let sessionId = "";
        while (sessionId === "") {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) === "native.session.result") {
                const result = decodeNativeSessionResult(message);
                if (result.action === "list") {
                    sessionId =
                        result.entries.find((entry) => entry.sessionId === peer.target.sessionId)?.sessionId ?? "";
                    expect(sessionId).not.toBe("");
                }
            }
        }
        peer.send(
            encodeSessionPreviewHistoryPageLoad({
                ...identity,
                cursor: null,
                eventLimit: 100,
                kind: "session.preview-history.page.load",
                requestId: randomUUID(),
                target: { harness: "codex", sessionId },
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind === "session.preview-history.page.loaded") {
                expect(questionMessages(decodeSessionPreviewHistoryPageLoaded(message).events.events.events)).toEqual(
                    asked,
                );
                break;
            }
        }
    });
});

function questionMessages(events: readonly SessionEventPayload[]) {
    return events.flatMap((event) =>
        event.type === "acp" &&
        event.payload.sessionUpdate === "agent_message_chunk" &&
        event.payload.content.type === "text" &&
        event.payload.questions !== undefined
            ? [{ text: event.payload.content.text, questions: event.payload.questions }]
            : [],
    );
}
