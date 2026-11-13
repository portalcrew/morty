import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

// The production cap is far above any test scenario, so scenarios that need
// retirement shrink the retained process budget of the embedded Runtime.
const evictingEnvironment = (environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> => ({
    ...environment,
    MORTY_TEST_MAX_ACP_PROCESSES: "2",
});

async function promptRealSession(
    peer: RealDaemonPeer,
    sessionTarget: RealDaemonPeer["target"],
    text: string,
): Promise<void> {
    const commandId = randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            kind: "session.prompt",
            commandId,
            requestId: commandId,
            target: sessionTarget,
            prompt: text,
            disposition: SessionPromptDisposition.Append,
            attachments: [],
        }),
    );
    let output = "";
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        }
        if (
            event.type === "acp" &&
            event.payload.sessionUpdate === "agent_message_chunk" &&
            event.payload.content.type === "text"
        ) {
            output += event.payload.content.text;
        }
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
            expect(event.payload.commandId).toBe(commandId);
            expect(event.target).toEqual(sessionTarget);
            expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
            expect(output).toContain("RESTORED_REPLY");
            return;
        }
    }
}

test("Given a real Codex conversation, When more Sessions are opened than the daemon can retain, Then the original native Session continues with its history intact", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "RESTORED_REPLY");
    await using agent = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), evictingEnvironment(agent.environment), async (peer) => {
        const sessionTarget = await prepareNewRealSession(peer, "codex");
        await promptRealSession(peer, sessionTarget, "Original conversation before opening other Sessions");
        for (let index = 0; index < 11; index += 1) {
            await prepareNewRealSession(peer, "codex");
        }
        await promptRealSession(peer, sessionTarget, "Continue the original conversation after opening other Sessions");
        peer.send(
            encodeSessionHistoryPageLoad({
                kind: "session.live-history.v2.page.load",
                requestId: randomUUID(),
                target: sessionTarget,
                cursor: null,
                eventLimit: 200,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) === "session.operation.failed") {
                throw new Error(message);
            }
            if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                continue;
            }
            const page = decodeSessionHistoryPageLoaded(message).events.events;
            const updates = page.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
            const userText = [
                ...new Set(
                    page.events.flatMap((event) => {
                        return event.type === "acp" &&
                            event.payload.sessionUpdate === "user_message_chunk" &&
                            event.payload.content.type === "text"
                            ? [event.payload.content.text]
                            : [];
                    }),
                ),
            ];
            expect(userText).toEqual([
                "Original conversation before opening other Sessions",
                "Continue the original conversation after opening other Sessions",
            ]);
            expect(updates.filter((update) => update.sessionUpdate === "agent_message_chunk")).toHaveLength(2);
            break;
        }
    });
});
