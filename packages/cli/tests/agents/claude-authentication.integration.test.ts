import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    encodeSessionHistoryPageLoad,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test("Given real Claude has expired OAuth credentials, When I send a message and reopen the session, Then authentication is required without diagnostic assistant text live or in history", async () => {
    await using agent = await ClaudeFixture.createExpiredOAuth();
    await withRealDaemon(
        new ClaudeCodeAgentSpecification(),
        agent.environment,
        async (peer) => {
            const sessionTarget = await prepareNewRealSession(peer, "claude");
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    requestId: commandId,
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "Reply with a greeting",
                    target: sessionTarget,
                }),
            );
            const output: string[] = [];
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    output.push(event.payload.content.text);
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    expect(event.payload.commandId).toBe(commandId);
                    expect(event.payload.code).toBe("authentication_required");
                    expect(output).toEqual([]);
                    break;
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    throw new Error("An unauthenticated turn must not complete successfully");
                }
            }

            // Restart drops the live Agent and reads the real native transcript on reopen.
            await peer.restart();
            const prepareId = randomUUID();
            peer.send(
                encodeSessionPrepareCommand({
                    kind: "session.prepare",
                    requestId: prepareId,
                    target: sessionTarget,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                if (kind === "session.operation.failed") {
                    throw new Error(message);
                }
                if (kind === "session.ready" && decodeSessionReadyEvent(message).requestId === prepareId) {
                    break;
                }
            }
            const requestId = randomUUID();
            peer.send(
                encodeSessionHistoryPageLoad({
                    cursor: null,
                    eventLimit: 100,
                    kind: "session.live-history.v2.page.load",
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
                if (kind !== "session.live-history.v2.page.loaded") {
                    continue;
                }
                const page = decodeSessionHistoryPageLoaded(message);
                if (page.requestId !== requestId) {
                    continue;
                }
                const history = page.events.events.events;
                expect(
                    history.some(
                        (event) => event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk",
                    ),
                ).toBe(true);
                expect(
                    history.filter(
                        (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk",
                    ),
                ).toEqual([]);
                break;
            }
        },
        "managed",
    );
});

test("Given a real Claude answer quotes login diagnostics, When it completes, Then the text remains an ordinary successful answer", async () => {
    const reply = "The diagnostic says: Please run /login. OAuth session expired and could not be refreshed.";
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", reply);
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                requestId: commandId,
                commandId,
                requestId: commandId,
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "Explain a login diagnostic without running tools",
                target: peer.target,
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
                expect(output).toContain(reply);
                break;
            }
        }
    });
});
