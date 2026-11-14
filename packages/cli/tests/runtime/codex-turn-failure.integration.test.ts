import { randomUUID } from "node:crypto";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

// @no-uc: Technical regression; a Codex turn failure reaches the member with Codex's own reason at the daemon boundary.
test("Given Codex fails a turn with a reason, When a member's prompt runs through the daemon, Then the failure event carries Codex's reason for that command and attempt after its user message", async () => {
    const reason = "You've hit your usage limit. Try again later.";
    await using codex = await ControlledCodexFixture.create({ failTurnWith: reason });
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId,
                requestId: commandId,
                target: peer.target,
                attachments: [],
                prompt: "Do the work",
                disposition: SessionPromptDisposition.Append,
                sessionConfigurations: [],
            }),
        );
        let attemptId: string | undefined;
        let userMessage: { readonly messageId: string | undefined; readonly text: string | undefined } | undefined;
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk") {
                userMessage = {
                    messageId: event.payload.messageId,
                    text: event.payload.content.type === "text" ? event.payload.content.text : undefined,
                };
            }
            if (event.type !== "lifecycle-metadata") {
                continue;
            }
            if (event.payload.kind === "prompt.started") {
                attemptId = event.payload.attemptId;
            }
            if (event.payload.kind === "prompt.completed") {
                throw new Error("The failing Codex turn completed");
            }
            if (event.payload.kind === "prompt.failed") {
                expect(attemptId).toBeDefined();
                expect(event.payload).toMatchObject({
                    attemptId,
                    code: "acp_agent_error",
                    commandId,
                    message: `Internal error: ${reason}`,
                });
                break;
            }
        }
        expect(userMessage).toEqual({ messageId: "controlled-user-1", text: "Do the work" });
    });
});
