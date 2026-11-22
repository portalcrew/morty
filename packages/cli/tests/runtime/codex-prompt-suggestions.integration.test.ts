import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    encodeSessionPromptCommand,
    SESSION_PROMPT_SUGGESTIONS_KIND,
    SessionPromptDisposition,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

test("Given Codex predicts the next prompt from a finished turn, When a member's prompt completes through the daemon, Then the member's open conversation is offered that prompt", async ({
    signal,
}) => {
    await using codex = await ControlledCodexFixture.create({ nextPrompt: "Run the tests again" });
    await withRealDaemon(signal, new CodexAgentSpecification(), codex.environment, async (peer) => {
        await peer.subscribe(peer.target);
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId,
                requestId: commandId,
                target: peer.target,
                attachments: [],
                prompt: "Fix the failing build",
                disposition: SessionPromptDisposition.Append,
                sessionConfigurations: [],
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) === SESSION_PROMPT_SUGGESTIONS_KIND) {
                expect(JSON.parse(message)).toMatchObject({
                    suggestions: [{ prompt: [{ text: "Run the tests again", type: "text" }] }],
                    target: peer.target,
                });
                return;
            }
        }
    });
});
