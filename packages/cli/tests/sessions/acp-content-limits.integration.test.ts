import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";

import { fakeAgent, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp content limits", () => {
    it("Given an ACP tool returns inline image bytes, When Morty records the tool update, Then the live event exposes an external image reference without inline bytes", async ({
        signal,
    }) => {
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            settledTurns: () => [],
            hasUnsettledTurn: () => false,
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        try {
            await manager.runPrompt({
                agent: fakeAgent(),
                commandId: "image-command",
                cwd: process.cwd(),
                images: [],
                prompt: "generate inline image",
                resources: [],
                target: await manager.createNativeSession({
                    agent: fakeAgent(),
                    cwd: process.cwd(),
                    signal,
                }),
                signal: new AbortController().signal,
            });

            const completed = observer
                .toolUpdates("tool-1")
                .findLast((update) => update.sessionUpdate === "tool_call_update");
            expect(completed).toMatchObject({
                sessionUpdate: "tool_call_update",
                status: "completed",
            });
            expect(
                observer
                    .acpUpdates()
                    .findLast(
                        (update) =>
                            update.sessionUpdate === "tool_call_update" &&
                            (update.content ?? []).some(
                                (item) => item.type === "content" && item.content.type === "external_image",
                            ),
                    ),
            ).toBeDefined();
        } finally {
            await manager.close();
        }
    });

    it("Given two Turns reuse a tool ID, When each Turn produces an image, Then each turn records its own external image event", async ({
        signal,
    }) => {
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            settledTurns: () => [],
            hasUnsettledTurn: () => false,
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        try {
            const target = await manager.createNativeSession({
                agent: fakeAgent(),
                cwd: process.cwd(),
                signal,
            });
            for (const commandId of ["first-image-turn", "second-image-turn"]) {
                await manager.runPrompt({
                    agent: fakeAgent(),
                    commandId,
                    cwd: process.cwd(),
                    images: [],
                    prompt: "generate inline image with reused tool id",
                    resources: [],
                    target,
                    signal: new AbortController().signal,
                });
            }
            expect(
                observer
                    .acpUpdates()
                    .filter(
                        (update) =>
                            (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
                            update.toolCallId === "reused-image-tool" &&
                            (update.content ?? []).some(
                                (item) => item.type === "content" && item.content.type === "external_image",
                            ),
                    ),
            ).toHaveLength(2);
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP tool returns more than 500,000 characters, When Morty records the tool update, Then the raw output stays intact in the event log", async ({
        signal,
    }) => {
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            settledTurns: () => [],
            hasUnsettledTurn: () => false,
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        try {
            await manager.runPrompt({
                agent: fakeAgent(),
                commandId: "oversized-tool-output-command",
                cwd: process.cwd(),
                images: [],
                prompt: "return oversized tool output",
                resources: [],
                target: await manager.createNativeSession({
                    agent: fakeAgent(),
                    cwd: process.cwd(),
                    signal,
                }),
                signal: new AbortController().signal,
            });

            const completed = observer
                .toolUpdates("tool-1")
                .findLast((update) => update.sessionUpdate === "tool_call_update");
            expect(completed).toMatchObject({ rawOutput: "x".repeat(500_001), status: "completed" });
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent streams oversized UTF-8 reasoning chunks, When it completes, Then live updates retain complete chunks without history truncation metadata", async ({
        signal,
    }) => {
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            settledTurns: () => [],
            hasUnsettledTurn: () => false,
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        try {
            await manager.runPrompt({
                agent: fakeAgent(),
                commandId: "oversized-reasoning-command",
                cwd: process.cwd(),
                images: [],
                prompt: "stream oversized reasoning",
                resources: [],
                target: await manager.createNativeSession({
                    agent: fakeAgent(),
                    cwd: process.cwd(),
                    signal,
                }),
                signal: new AbortController().signal,
            });
            const reasoning = observer
                .acpUpdates()
                .map((update) =>
                    update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text"
                        ? update.content.text
                        : null,
                )
                .filter((text): text is string => text !== null);
            expect(reasoning).toEqual([
                "Inspecting ",
                "the workspace",
                ...Array.from({ length: 8 }, (_, index) => {
                    return (
                        "discarded prefix" +
                        "\u601d\u{1f600}r".repeat(12_000) +
                        ` tail-${index.toString()}${"!".repeat(index % 3)}`
                    );
                }),
            ]);
            expect(
                observer
                    .acpUpdates()
                    .flatMap((update) => (update.sessionUpdate === "agent_thought_chunk" ? [update.meta] : [])),
            ).toEqual(Array.from({ length: 10 }, () => undefined));
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP agent links a local image in Markdown, When Morty records the reply, Then the reply text preserves the original path", async ({
        signal,
    }) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-markdown-image-"));
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            settledTurns: () => [],
            hasUnsettledTurn: () => false,
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        try {
            await manager.runPrompt({
                agent: fakeAgent(),
                commandId: "markdown-image-command",
                cwd: directory,
                images: [],
                prompt: "generate markdown image",
                resources: [],
                target: await manager.createNativeSession({
                    agent: fakeAgent(),
                    cwd: directory,
                    signal,
                }),
                signal: new AbortController().signal,
            });

            expect(observer.agentText()).toContain(
                `![Generated image](<${await realpath(join(directory, "generated-image.png"))}`,
            );
        } finally {
            await manager.close();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("Given an ACP Agent links an image outside its workspace, When Morty records the reply, Then the reply text preserves the Agent path", async ({
        signal,
    }) => {
        const workspace = await mkdtemp(join(tmpdir(), "morty-agent-workspace-"));
        const generatedImages = await mkdtemp(join(tmpdir(), "morty-agent-generated-images-"));
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            settledTurns: () => [],
            hasUnsettledTurn: () => false,
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        try {
            await manager.runPrompt({
                agent: fakeAgent([], { FAKE_ACP_IMAGE_DIRECTORY: generatedImages }),
                commandId: "codex-generated-image-command",
                cwd: workspace,
                images: [],
                prompt: "generate markdown image",
                resources: [],
                target: await manager.createNativeSession({
                    agent: fakeAgent([], { FAKE_ACP_IMAGE_DIRECTORY: generatedImages }),
                    cwd: workspace,
                    signal,
                }),
                signal: new AbortController().signal,
            });

            expect(observer.agentText()).toContain(
                `![Generated image](<${join(generatedImages, "generated-image.png")}`,
            );
        } finally {
            await manager.close();
            await Promise.all([
                rm(workspace, { force: true, recursive: true }),
                rm(generatedImages, { force: true, recursive: true }),
            ]);
        }
    });

    it("Given an ACP agent returns image and video output, When Morty records the reply, Then the image stays referenced in text and the video is externalized", async ({
        signal,
    }) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-media-output-"));
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: acpAdapters,
            onSessionClosed: () => undefined,
            settledTurns: () => [],
            hasUnsettledTurn: () => false,
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        try {
            await manager.runPrompt({
                agent: fakeAgent(),
                commandId: "media-command",
                cwd: directory,
                images: [],
                prompt: "generate media artifacts",
                resources: [],
                target: await manager.createNativeSession({
                    agent: fakeAgent(),
                    cwd: directory,
                    signal,
                }),
                signal: new AbortController().signal,
            });

            expect(observer.agentText()).toContain(
                `![Generated image](<${await realpath(join(directory, "generated-image.png"))}`,
            );
            expect(
                observer
                    .acpUpdates()
                    .findLast(
                        (update) =>
                            update.sessionUpdate === "agent_message_chunk" &&
                            update.content.type === "external_resource",
                    ),
            ).toMatchObject({
                content: {
                    byteLength: 24,
                    encoding: "binary",
                    mimeType: "video/mp4",
                    resourceKey: expect.any(String),
                    type: "external_resource",
                    uri: "file:///generated-video.mp4",
                },
                sessionUpdate: "agent_message_chunk",
            });
        } finally {
            await manager.close();
            await rm(directory, { force: true, recursive: true });
        }
    });
});
