import { randomUUID } from "node:crypto";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given real pi exhausts its automatic model retries, When the last attempt still fails, Then the turn reports the real model error instead of claiming a resume, and a follow-up turn still runs", async () => {
    // Every request for the marked prompt fails with HTTP 500, which pi classifies
    // as a retryable provider error, so its automatic retry loop runs and exhausts.
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "RETRY_RECOVERY_REPLY", {
        failPromptContaining: "RETRY_EXHAUSTION_PROBE",
        failureMessage: "fake provider failure",
    });
    await using agent = await PiFixture.create(provider);
    // Keep the retry loop real but fast: one retry, then exhaustion.
    await agent.overrideSettings({ retry: { baseDelayMs: 10, maxRetries: 1 } });
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const sendPrompt = (prompt: string): string => {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    requestId: commandId,
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt,
                    target: peer.target,
                }),
            );
            return commandId;
        };

        const failingCommandId = sendPrompt(
            "RETRY_EXHAUSTION_PROBE Controlled retry-exhaustion verification. Reply only RETRY_SHOULD_NOT_SUCCEED.",
        );
        let failure: { readonly code: string; readonly message: string } | null = null;
        let transcript = "";
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                (event.payload.sessionUpdate === "agent_message_chunk" ||
                    event.payload.sessionUpdate === "agent_thought_chunk") &&
                event.payload.content.type === "text"
            ) {
                transcript += event.payload.content.text;
            }
            const terminal =
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.completed")
                    ? event.payload
                    : null;
            if (terminal !== null && terminal.commandId === failingCommandId) {
                if (terminal.kind === "prompt.completed") {
                    throw new Error(`The exhausted turn completed: ${JSON.stringify(terminal)}`);
                }
                failure = { code: terminal.code, message: terminal.message };
                break;
            }
        }

        // Retry lifecycle is not model output: the transcript stays empty of retry
        // narration (no "Retrying", no false "resuming") and of any failed answer.
        expect(transcript).not.toContain("Retrying");
        expect(transcript).not.toContain("resuming");
        expect(transcript).not.toContain("Retries exhausted");
        expect(transcript).not.toContain("RETRY_SHOULD_NOT_SUCCEED");
        // The prompt failure alone carries the real model error for the user.
        expect(failure?.code).toBe("acp_agent_error");
        expect(failure?.message).toContain("fake provider failure");

        // Only the model call failed; the settled pi session still serves a
        // follow-up turn, matching the Claude and Codex failure contracts.
        const recoveredCommandId = sendPrompt("Recovery check. Reply with a short greeting.");
        let recovered = "";
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                recovered += event.payload.content.text;
            }
            const terminal =
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.completed")
                    ? event.payload
                    : null;
            if (terminal !== null && terminal.commandId === recoveredCommandId) {
                if (terminal.kind === "prompt.failed") {
                    throw new Error(`The follow-up turn failed: ${JSON.stringify(terminal)}`);
                }
                expect(terminal.stopReason).toBe("end_turn");
                break;
            }
        }
        expect(recovered).toContain("RETRY_RECOVERY_REPLY");
    });
});

test("Given a pi turn's first model call fails retryably, When pi's automatic retry recovers within the same turn, Then the turn settles end_turn with the answer instead of failing on the earlier error", async () => {
    // The marked prompt fails its first request with a retryable HTTP 500; pi's
    // automatic retry re-issues it and the provider then answers normally. The
    // recovery happens inside one ACP turn, so a mid-run retry failure must not
    // brand the finally-successful turn as failed.
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "RETRY_RECOVERED_REPLY", {
        failPromptContaining: "RETRY_RECOVERY_PROBE",
        failMatchCount: 1,
        failureMessage: "fake provider transient failure",
    });
    await using agent = await PiFixture.create(provider);
    await agent.overrideSettings({ retry: { baseDelayMs: 10, maxRetries: 1 } });
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                requestId: commandId,
                commandId,
                requestId: commandId,
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "RETRY_RECOVERY_PROBE Controlled same-turn recovery verification.",
                target: peer.target,
            }),
        );

        let text = "";
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                (event.payload.sessionUpdate === "agent_message_chunk" ||
                    event.payload.sessionUpdate === "agent_thought_chunk") &&
                event.payload.content.type === "text"
            ) {
                text += event.payload.content.text;
            }
            if (event.type === "lifecycle-metadata") {
                if (event.payload.kind === "prompt.failed") {
                    throw new Error(`The recovered turn failed: ${JSON.stringify(event.payload)}`);
                }
                if (event.payload.kind === "prompt.completed" && event.payload.commandId === commandId) {
                    expect(event.payload.stopReason).toBe("end_turn");
                    break;
                }
            }
        }
        // The retried attempt's answer streamed into the same turn; no retry
        // narration entered the transcript.
        expect(text).toContain("RETRY_RECOVERED_REPLY");
        expect(text).not.toContain("Retrying");
        expect(text).not.toContain("resuming");
    });
});
