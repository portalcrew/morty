import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    decodeContentChunkFrame,
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    encodeFileReadCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    type SessionEvent,
    type SessionLiveEvent,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
);

function imageKeys(events: readonly (SessionEvent | SessionLiveEvent)[]): readonly string[] {
    return events.flatMap((event) => {
        if (
            event.type !== "acp" ||
            (event.payload.sessionUpdate !== "tool_call" && event.payload.sessionUpdate !== "tool_call_update")
        ) {
            return [];
        }
        return (event.payload.content ?? []).flatMap((item) =>
            item.type === "content" && item.content.type === "external_image" ? [item.content.imageKey] : [],
        );
    });
}

test("Given real Claude reads an image, When its reply streams and native history reopens, Then clients retrieve identical bytes without base64 in tool output and can continue chatting", async () => {
    const imagePrompt = "Use the read tool to inspect picture.png, then reply";
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "IMAGE_REPLY", {
        readPath: "picture.png",
        toolPrompt: imagePrompt,
    });
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const key = createHash("sha256").update(image).digest("hex");
        await writeFile(join(peer.workspace, "picture.png"), image);
        const sendPrompt = (commandId: string, prompt: string): void =>
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
        const finish = async (): Promise<readonly SessionLiveEvent[]> => {
            const events: SessionLiveEvent[] = [];
            for (;;) {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                expect(message).not.toContain(image.toString("base64"));
                if (kind === "session.operation.failed") {
                    throw new Error(message);
                }
                if (kind === "session.event.v2") {
                    const batch = decodeSessionEventEnvelope(message).events;
                    events.push(...batch);
                    for (const event of batch) {
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "session.permission.requested"
                        ) {
                            const option = event.payload.event.options.find((entry) => entry.kind === "allow_once");
                            if (option === undefined) {
                                throw new Error("No one-time image read permission");
                            }
                            peer.send(
                                encodeSessionPermissionRespondCommand({
                                    kind: "session.permission.respond",
                                    requestId: crypto.randomUUID(),
                                    target: peer.target,
                                    interactionId: event.payload.event.interactionId,
                                    optionId: option.optionId,
                                    outcome: "selected",
                                }),
                            );
                        }
                    }
                    const failure = batch.find(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            (event.payload.kind === "prompt.failed" ||
                                event.payload.kind === "prompt.failed-before-start"),
                    );
                    if (failure !== undefined) {
                        throw new Error(JSON.stringify(failure));
                    }
                    if (
                        batch.some(
                            (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
                        )
                    ) {
                        return events;
                    }
                }
            }
        };
        sendPrompt("image-turn", imagePrompt);
        expect(imageKeys(await finish())).toContain(key);
        peer.send(
            encodeSessionHistoryPageLoad({
                cursor: null,
                eventLimit: 50,
                kind: "session.live-history.v2.page.load",
                requestId: "image-history",
                target: peer.target,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind === "session.live-history.v2.page.loaded") {
                expect(message).not.toContain(image.toString("base64"));
                expect(imageKeys(decodeSessionHistoryPageLoaded(message).events.events.events)).toContain(key);
                break;
            }
        }
        peer.send(
            encodeFileReadCommand({
                kind: "file.read",
                maxBytes: 2_000_000,
                path: `morty-content:image:${key}`,
                requestId: "image-download",
                target: peer.target,
            }),
        );
        const chunks: Buffer[] = [];
        for (;;) {
            const message = await peer.nextFrame();
            if (typeof message !== "string") {
                chunks.push(Buffer.from(decodeContentChunkFrame(message).bytes));
                continue;
            }
            const kind = decodeMessageKind(message);
            if (kind === "file.failed") {
                throw new Error(message);
            }
            if (kind === "file.end") {
                break;
            }
        }
        expect(Buffer.concat(chunks)).toEqual(image);
        sendPrompt("continue-turn", "Continue with a short reply, without using tools");
        await finish();
    });
});
