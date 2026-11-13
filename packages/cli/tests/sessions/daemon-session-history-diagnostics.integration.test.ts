import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    decodeContentChunkFrame,
    decodeFileBeginEvent,
    decodeFileEndEvent,
    decodeMessageKind,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    decodeSessionOperationFailedEvent,
    encodeFileReadCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withControlledDaemon as withRealDaemon } from "../support/agents/real-daemon.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

test("Given native history contains oversized and embedded ACP media, When Chat loads V2 history, Then it receives retrievable keys instead of embedded bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-external-history-image-"));
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "controlled-acp");
    await mkdir(executableDirectory);
    await writeFile(
        executable,
        `#!${process.execPath}
if (process.argv.includes("--version")) {
  process.stdout.write("1.0.0\\n");
} else {
  process.argv.push(
    "--agent-name", "Controlled ACP",
    "--agent-version", "1.0.0",
    "--http-mcp",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`,
        { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    try {
        await withRealDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MORTY_FAKE_ACP_OVERSIZED_HISTORY_IMAGE: "1",
                MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "state"),
                PATH: executableDirectory,
            },
            async (peer) => {
                peer.send(
                    encodeSessionPrepareCommand({
                        kind: "session.prepare",
                        requestId: "prepare-external-image-session",
                        target: peer.target,
                    }),
                );
                for (;;) {
                    if (decodeMessageKind(await peer.nextMessage()) === "session.ready") {
                        break;
                    }
                }
                peer.send(
                    encodeSessionPromptCommand({
                        commandId: "external-image-seed-turn",
                        requestId: "external-image-seed-turn",
                        disposition: SessionPromptDisposition.Append,
                        attachments: [],
                        kind: "session.prompt",
                        prompt: "Seed native history",
                        target: peer.target,
                    }),
                );
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        break;
                    }
                }
                peer.send(
                    encodeSessionHistoryPageLoad({
                        cursor: null,
                        eventLimit: 50,
                        kind: "session.live-history.v2.page.load",
                        requestId: "load-external-image-history",
                        target: peer.target,
                    }),
                );
                let imageKey = "";
                let audioKey = "";
                let resourceKey = "";
                for (;;) {
                    const message = await peer.nextMessage();
                    const messageKind = decodeMessageKind(message);
                    if (messageKind === "session.operation.failed") {
                        throw new Error(JSON.stringify(decodeSessionOperationFailedEvent(message)));
                    }
                    if (messageKind !== "session.live-history.v2.page.loaded") {
                        continue;
                    }
                    const events = decodeSessionHistoryPageLoaded(message).events.events.events;
                    expect(JSON.stringify(events).length).toBeLessThan(10_000);
                    expect(JSON.stringify(events)).not.toContain("iVBORw0KGgoAAAANSUhEUg");
                    for (const event of events) {
                        if (event.type !== "acp" || event.payload.sessionUpdate !== "tool_call_update") {
                            continue;
                        }
                        for (const item of event.payload.content ?? []) {
                            if (item.type === "content" && item.content.type === "external_image") {
                                imageKey = item.content.imageKey;
                            } else if (item.type === "content" && item.content.type === "external_audio") {
                                audioKey = item.content.audioKey;
                            } else if (item.type === "content" && item.content.type === "external_resource") {
                                resourceKey = item.content.resourceKey;
                            }
                        }
                    }
                    break;
                }
                expect(imageKey).toMatch(/^[a-f0-9]{64}$/u);
                expect(audioKey).toMatch(/^[a-f0-9]{64}$/u);
                expect(resourceKey).toMatch(/^[a-f0-9]{64}$/u);

                const readContent = async (kind: "audio" | "image" | "resource", key: string, mediaType: string) => {
                    peer.send(
                        encodeFileReadCommand({
                            kind: "file.read",
                            maxBytes: 2_000_000,
                            path: `morty-content:${kind}:${key}`,
                            requestId: `read-external-${kind}`,
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
                        const messageKind = decodeMessageKind(message);
                        if (messageKind === "file.begin") {
                            expect(decodeFileBeginEvent(message).mediaType).toBe(mediaType);
                        } else if (messageKind === "file.end") {
                            decodeFileEndEvent(message);
                            break;
                        }
                    }
                    return Buffer.concat(chunks);
                };
                const image = await readContent("image", imageKey, "image/png");
                const audio = await readContent("audio", audioKey, "audio/wav");
                const resource = await readContent("resource", resourceKey, "text/plain");
                expect(image.byteLength).toBeGreaterThan(750_000);
                expect(createHash("sha256").update(image).digest("hex")).toBe(imageKey);
                expect(audio).toEqual(Buffer.from([1, 2, 3, 4]));
                expect(resource.toString("utf8")).toBe("Generated resource");
            },
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
