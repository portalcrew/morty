import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    PROMPT_IMAGE_MAX_BYTES,
    type PromptAttachment,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withControlledDaemon } from "../support/agents/real-daemon.ts";
import { uploadPromptContent } from "../support/agents/upload-prompt-content.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

afterEach(() => vi.useRealTimers());

test("Given unsupported attachments, When a prompt has text, Then the daemon delivers the original text without losing the connection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T08:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "old-pdf-peer-"));
    try {
        const executable = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executable,
            },
            async (peer) => {
                const finish = async (id: string) => {
                    let output = "";
                    for (;;) {
                        const raw = await peer.nextMessage();
                        if (JSON.parse(raw).kind !== "session.event.v2") {
                            continue;
                        }
                        for (const event of decodeSessionEventEnvelope(raw).events) {
                            if (event.type === "acp") {
                                if (
                                    event.payload.sessionUpdate === "agent_message_chunk" &&
                                    event.payload.content.type === "text"
                                ) {
                                    output += event.payload.content.text;
                                }
                                continue;
                            }
                            const payload = event.payload;
                            if (!("commandId" in payload) || payload.commandId !== id) {
                                continue;
                            }
                            if (
                                ["prompt.completed", "prompt.failed", "prompt.failed-before-start"].includes(
                                    payload.kind,
                                )
                            ) {
                                return { payload, output };
                            }
                        }
                    }
                };
                const send = async (attachments: readonly PromptAttachment[], prompt: string) => {
                    const commandId = randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            attachments,
                            commandId,
                            requestId: commandId,
                            disposition: SessionPromptDisposition.Append,
                            kind: "session.prompt",
                            prompt,
                            target: peer.target,
                        }),
                    );
                    return finish(commandId);
                };
                for (const input of [
                    {
                        bytes: new Uint8Array(PROMPT_IMAGE_MAX_BYTES + 1),
                        mediaType: "image/png",
                        name: "large.png",
                    },
                    {
                        bytes: new Uint8Array(PROMPT_IMAGE_MAX_BYTES + 2),
                        mediaType: "image/jpeg",
                        name: "large.jpg",
                    },
                ]) {
                    const attachment = await uploadPromptContent(peer, {
                        ...input,
                        kind: "image",
                        uri: `attachment:///${input.name}`,
                    });
                    const outcome = await send([attachment], "Read attached file");
                    expect(outcome.payload.kind).toBe("prompt.completed");
                    expect(outcome.output).toMatch(/Controlled ACP turn \d+: Read attached file$/u);
                    const onlyAttachment = await send([attachment], "");
                    expect(onlyAttachment.payload).toMatchObject({
                        kind: "prompt.failed-before-start",
                        code: "prompt_attachments_unsupported",
                    });
                    const recovery = await send([], "Still connected after attachment rejection");
                    expect(recovery.payload.kind).toBe("prompt.completed");
                }
                expect((await peer.readDiagnostics()).match(/"event":"prompt_attachments_skipped"/gu)).toHaveLength(1);
                vi.setSystemTime(new Date("2026-10-28T08:01:00Z"));
                const attachment = await uploadPromptContent(peer, {
                    bytes: new Uint8Array(PROMPT_IMAGE_MAX_BYTES + 3),
                    kind: "image",
                    mediaType: "image/png",
                    name: "again.png",
                    uri: "attachment:///again.png",
                });
                await send([attachment], "Continue after the log interval");
                const logs = await peer.readDiagnostics();
                expect(logs.match(/"event":"prompt_attachments_skipped"/gu)).toHaveLength(2);
                expect(logs).toContain('"skippedCount":"4"');
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
