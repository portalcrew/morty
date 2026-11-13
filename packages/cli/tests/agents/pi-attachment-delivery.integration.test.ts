import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
    decodeSessionLiveEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { uploadPromptContent } from "../support/agents/upload-prompt-content.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

test("Given real Pi receives a file attachment, When the Agent reads its local link, Then the attachment text is returned by the tool and the turn completes", async () => {
    const toolPrompt = "Use the read tool to inspect the attached file, then reply";
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_ATTACHMENT_REPLY", {
        toolPrompt,
        readPath: (prompt) => {
            const uri = /\[Context\] (file:\/\/\/[^\n]+)/u.exec(prompt)?.[1];
            if (uri === undefined) {
                throw new Error("No local attachment link reached Pi");
            }
            return fileURLToPath(uri);
        },
    });
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
        const commandId = randomUUID();
        const attachment = await uploadPromptContent(peer, {
            bytes: new TextEncoder().encode(fakeProviderPrompts.successfulTool),
            kind: "resource",
            mediaType: "text/markdown",
            name: "instructions.md",
            uri: "attachment:///instructions.md",
        });
        peer.send(
            encodeSessionPromptCommand({
                commandId,
                requestId: commandId,
                disposition: SessionPromptDisposition.Append,
                attachments: [attachment],
                kind: "session.prompt",
                prompt: toolPrompt,
                target: peer.target,
            }),
        );
        let text = "";
        let attachmentRead = false;
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (event.type === "acp" && event.payload.sessionUpdate === "tool_call_update") {
                attachmentRead ||= JSON.stringify(event.payload).includes(fakeProviderPrompts.successfulTool);
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                const option = event.payload.event.options.find((entry) => entry.kind === "allow_once");
                if (option === undefined) {
                    throw new Error("No one-time tool permission option");
                }
                peer.send(
                    encodeSessionPermissionRespondCommand({
                        kind: "session.permission.respond",
                        requestId: crypto.randomUUID(),
                        interactionId: event.payload.event.interactionId,
                        optionId: option.optionId,
                        outcome: "selected",
                        target: peer.target,
                    }),
                );
            } else if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                text += event.payload.content.text;
            } else if (
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
            ) {
                throw new Error(JSON.stringify(event));
            } else if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === commandId
            ) {
                expect(event.payload.stopReason).toBe("end_turn");
                break;
            }
        }
        expect(attachmentRead).toBe(true);
        expect(text).toContain("PI_ATTACHMENT_REPLY");
        expect(text).toContain("tool result observed");
        expect(provider.diagnostics()).toHaveLength(2);
    });
});
