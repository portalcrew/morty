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

test("Given an owned Codex session, When Codex changes collaboration mode during a turn, Then the user receives the updated Plan selection before completion", async () => {
    await using codex = await ControlledCodexFixture.create();
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId,
                requestId: commandId,
                target: peer.target,
                attachments: [],
                prompt: "Enter Plan mode",
                disposition: SessionPromptDisposition.Append,
                sessionConfigurations: [],
            }),
        );
        const selections: string[] = [];
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "acp" && event.payload.sessionUpdate === "config_option_update") {
                const option = event.payload.configOptions.find((option) => option.id === "collaboration_mode");
                if (option?.type === "select") {
                    selections.push(option.currentValue);
                }
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                throw new Error(JSON.stringify(event));
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                break;
            }
        }
        expect(selections).toEqual(["plan"]);
    });
});
