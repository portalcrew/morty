import { createHash, randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { watch } from "node:fs";
import {
    decodeContentChunkFrame,
    decodeMessageKind,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    encodeFileReadCommand,
    encodeNativeSessionCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { imageFixture } from "../support/agents/image-fixture.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { nextNativeSessionResult, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { uploadPromptContent } from "../support/agents/upload-prompt-content.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.each(["pi", "claude", "codex"] as const)(
    "Given real %s saved uploaded text files and an image, When two independent forks reload their history, Then original downloads and images remain readable without changing the source",
    async (harness) => {
        await using provider =
            harness === "claude"
                ? await FakeAnthropicProvider.start("claude-sonnet-4-6", "ATTACHMENTS_SAVED")
                : await FakeOpenAiProvider.start(
                      harness === "pi" ? "gpt-4.1" : "morty-test-model",
                      "ATTACHMENTS_SAVED",
                  );
        await using agent =
            provider instanceof FakeAnthropicProvider
                ? await ClaudeFixture.create(provider)
                : harness === "pi"
                  ? await PiFixture.create(provider)
                  : await CodexFixture.create(provider);
        const specification =
            harness === "pi"
                ? new PiAgentSpecification()
                : harness === "claude"
                  ? new ClaudeCodeAgentSpecification()
                  : new CodexAgentSpecification();
        await withRealDaemon(specification, agent.environment, async (peer) => {
            const identity = {
                harness,
                directory: ".",
            };
            const image = imageFixture(32);
            const resource = Buffer.from("FORK_ATTACHMENT_ORIGINAL\n17 + 25 = 42\n", "utf8");
            const secondResource = Buffer.from("A second independent attachment\n", "utf8");
            const attachments = [];
            for (const content of [
                { bytes: resource, kind: "resource" as const, mediaType: "text/plain", name: "original-notes.txt" },
                { bytes: secondResource, kind: "resource" as const, mediaType: "text/plain", name: "second notes.txt" },
                { bytes: image, kind: "image" as const, mediaType: "image/png", name: "original-image.png" },
            ]) {
                attachments.push(await uploadPromptContent(peer, { ...content, uri: `attachment:///${content.name}` }));
            }
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    kind: "session.prompt",
                    commandId,
                    requestId: commandId,
                    target: peer.target,
                    disposition: SessionPromptDisposition.Append,
                    attachments,
                    prompt: "Keep the attached text and image in this conversation, without using tools",
                }),
            );
            await finish(peer);
            const source = await nativeSource(peer, harness, agent.environment["CLAUDE_CONFIG_DIR"]);
            for (let index = 0; index < 2; index++) {
                const requestId = randomUUID();
                peer.send(
                    encodeNativeSessionCommand({
                        ...identity,
                        kind: "native.session.request",
                        requestId,
                        action: "fork",
                        sessionId: source.sessionId,
                    }),
                );
                const fork = await nextNativeSessionResult(peer, requestId);
                if (fork.action !== "fork") {
                    throw new Error("Expected native fork");
                }
                const childTarget = fork.target;
                expect(childTarget.sessionId).not.toBe(peer.target.sessionId);
                for (let reload = 0; reload < 2; reload++) {
                    const chunks = await history(peer, childTarget);
                    const links = chunks.flatMap((chunk) =>
                        chunk.content.type === "resource_link" ? [chunk.content] : [],
                    );
                    expect
                        .soft(links)
                        .toContainEqual(
                            expect.objectContaining({ name: "original-notes.txt", mimeType: "text/plain" }),
                        );
                    const link = links.find((content) => content.name === "original-notes.txt");
                    if (link !== undefined) {
                        expect(await download(peer, childTarget, link.uri)).toEqual(resource);
                    }
                    const secondLink = links.find((content) => content.name === "second notes.txt");
                    expect.soft(secondLink).toBeDefined();
                    if (secondLink !== undefined) {
                        expect(await download(peer, childTarget, secondLink.uri)).toEqual(secondResource);
                    }
                    const images = chunks.flatMap((chunk) =>
                        chunk.content.type === "external_image" ? [chunk.content] : [],
                    );
                    const imageKey = createHash("sha256").update(image).digest("hex");
                    expect.soft(images).toContainEqual(expect.objectContaining({ imageKey, mimeType: "image/png" }));
                    if (images.some((content) => content.imageKey === imageKey)) {
                        expect(await download(peer, childTarget, `morty-content:image:${imageKey}`)).toEqual(image);
                    }
                    expect(
                        chunks.some(
                            (chunk) =>
                                chunk.content.type === "text" && chunk.content.text.includes("Keep the attached text"),
                        ),
                    ).toBe(true);
                }
                const childCommandId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        commandId: childCommandId,
                        requestId: childCommandId,
                        target: childTarget,
                        disposition: SessionPromptDisposition.Append,
                        attachments: [],
                        prompt: `Independent fork ${index}, reply without tools`,
                    }),
                );
                await finish(peer);
            }
            const original = await history(peer, peer.target);
            expect(
                original.some(
                    (chunk) => chunk.content.type === "text" && chunk.content.text.includes("Independent fork"),
                ),
            ).toBe(false);
        });
    },
);

async function finish(peer: RealDaemonPeer): Promise<void> {
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (event.type !== "lifecycle-metadata") {
            continue;
        }
        if (event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        }
        if (event.payload.kind === "prompt.completed") {
            expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
            return;
        }
    }
}

async function nativeSource(peer: RealDaemonPeer, harness: string, configDirectory: string | undefined) {
    // Claude flushes native history after live completion. Wait for its filesystem notification, not a polling delay.
    type NativeWrite = { readonly kind: "changed" } | { readonly kind: "failed"; readonly cause: Error };
    let changed = Promise.withResolvers<NativeWrite>();
    const watcher =
        configDirectory === undefined
            ? undefined
            : watch(configDirectory, { recursive: true }, () => changed.resolve({ kind: "changed" }));
    watcher?.on("error", (cause) => changed.resolve({ kind: "failed", cause }));
    using _abort = addAbortListener(peer.signal, () => changed.resolve({ kind: "changed" }));
    try {
        for (;;) {
            peer.signal.throwIfAborted();
            const notification = changed.promise;
            const requestId = randomUUID();
            peer.send(
                encodeNativeSessionCommand({
                    harness,
                    directory: ".",
                    kind: "native.session.request",
                    requestId,
                    action: "list",
                    cursor: null,
                }),
            );
            const listed = await nextNativeSessionResult(peer, requestId);
            if (listed.action !== "list") {
                throw new Error("Expected native session list");
            }
            const source = listed.entries.find((entry) => entry.sessionId === peer.target.sessionId);
            if (source !== undefined) {
                return { ...source };
            }
            if (watcher === undefined) {
                throw new Error("Missing source Session");
            }
            const event = await notification;
            if (event.kind === "failed") {
                throw event.cause;
            }
            changed = Promise.withResolvers<NativeWrite>();
        }
    } finally {
        watcher?.close();
    }
}

async function history(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"]) {
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
        const result = decodeSessionHistoryPageLoaded(message);
        if (result.requestId !== requestId) {
            continue;
        }
        return result.events.events.events.flatMap((event) =>
            event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk" ? [event.payload] : [],
        );
    }
}

async function download(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"], path: string): Promise<Buffer> {
    peer.send(
        encodeFileReadCommand({
            kind: "file.read",
            maxBytes: 2_000_000,
            path,
            requestId: randomUUID(),
            target: sessionTarget,
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
        if (kind === "file.failed" || kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind === "file.end") {
            return Buffer.concat(chunks);
        }
    }
}
