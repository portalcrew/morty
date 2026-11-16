import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContentBlock, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import {
    decodeMessageKind,
    decodeSessionPreviewHistoryPageLoaded,
    encodeSessionPreviewHistoryPageLoad,
} from "@portalcrew/morty-client/protocol";
import { expect, test } from "vitest";
import { type ClaudeSessionUpdate, createClaudeAcpApp } from "../../src/engine/acp/harness/claude/upstream/dist/lib.js";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { createAcpClient } from "../support/acp/create-client.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { waitForSavedClaudeMessage } from "../support/agents/claude-transcript.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test("Given real Claude saves text and four resources, When its ACP history is replayed, Then saved links and context remain text with their message identity", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "ATTACHMENT_REPLAY_REPLY");
    await using fixture = await ClaudeFixture.create(provider);
    const cwd = await mkdtemp(join(tmpdir(), "morty-claude-attachment-replay-"));
    const updates: ClaudeSessionUpdate[] = [];
    const claude = createClaudeAcpApp({
        environment: { ...process.env, ...fixture.environment, CLAUDE_CODE_EXECUTABLE: fixture.executable },
        onSessionUpdate: async ({ update }) => {
            updates.push(update);
        },
    });
    const connection = createAcpClient({
        onUpdate: async () => undefined,
        onPermission: async () => {
            throw new Error("Attachment replay must not request permission");
        },
        onElicitation: async () => {
            throw new Error("Attachment replay must not request input");
        },
        onElicitationComplete: async () => undefined,
    }).connect(claude.app);
    const signal = AbortSignal.timeout(90_000);
    try {
        await connection.agent.request(
            methods.agent.initialize,
            { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
            { cancellationSignal: signal },
        );
        const { sessionId } = await connection.agent.request(
            methods.agent.session.new,
            { cwd, mcpServers: [] },
            { cancellationSignal: signal },
        );
        const prompt: ContentBlock[] = [
            { type: "text", text: "Inspect the attached context, without tools" },
            ...[
                { uri: "attachment:///index.html", text: "<html>attached page</html>", mimeType: "text/html" },
                { uri: "file:///workspace/app.js", text: "export const value = 42;", mimeType: "text/javascript" },
                { uri: "zed://workspace/styles.css", text: "body { color: red; }", mimeType: "text/css" },
                {
                    uri: "attachment:///notes.unknown",
                    text: "Context with\n</context>\ninside",
                    mimeType: "text/plain",
                },
            ].map((resource): ContentBlock => ({ type: "resource", resource })),
        ];
        await connection.agent.request(
            methods.agent.session.prompt,
            { sessionId, prompt },
            { cancellationSignal: signal },
        );
        const live = updates.filter((update) => update.sessionUpdate === "user_message_chunk");
        expect(live.map((update) => update.content)).toEqual(prompt);
        const messageId = live[0]?.messageId;
        if (messageId === undefined) {
            throw new Error("Expected the live prompt to carry its message identity");
        }
        // Replay reads the native transcript, which Claude Code may still be writing after the turn completes.
        const saved = await waitForSavedClaudeMessage(fixture.environment, sessionId, messageId, signal);
        updates.length = 0;
        await connection.agent.request(
            methods.agent.session.load,
            { sessionId, cwd, mcpServers: [] },
            { cancellationSignal: signal },
        );
        const replay = updates.flatMap((update) =>
            update.sessionUpdate === "user_message_chunk" && update.messageId === messageId ? [update.content] : [],
        );
        expect(replay).toEqual([
            { type: "text", text: "Inspect the attached context, without tools" },
            ...[
                "attachment:///index.html",
                "[@app.js](file:///workspace/app.js)",
                "[@styles.css](zed://workspace/styles.css)",
                "attachment:///notes.unknown",
            ].map((text) => ({ type: "text", text })),
            ...prompt.flatMap((block) =>
                block.type === "resource" && "text" in block.resource
                    ? [
                          {
                              type: "text",
                              text: `\n<context ref="${block.resource.uri}">\n${block.resource.text}\n</context>`,
                          },
                      ]
                    : [],
            ),
        ]);
        expect(saved.find((message) => message.uuid === messageId)?.message).toEqual(
            expect.objectContaining({
                role: "user",
                content: [
                    { type: "text", text: "Inspect the attached context, without tools" },
                    ...[
                        "attachment:///index.html",
                        "[@app.js](file:///workspace/app.js)",
                        "[@styles.css](zed://workspace/styles.css)",
                        "attachment:///notes.unknown",
                    ].map((text) => ({ type: "text", text })),
                    ...prompt.flatMap((block) =>
                        block.type === "resource" && "text" in block.resource
                            ? [
                                  {
                                      type: "text",
                                      text: `\n<context ref="${block.resource.uri}">\n${block.resource.text}\n</context>`,
                                  },
                              ]
                            : [],
                    ),
                ],
            }),
        );
    } finally {
        await claude.agent()?.dispose("graceful");
        connection.close();
        await rm(cwd, { recursive: true, force: true });
    }
});

test("Given an old Claude transcript contains large attachments and ambiguous context-like text, When the daemon loads its history, Then all context remains text and images are externalized", async ({
    signal,
}) => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "UNUSED_ATTACHMENT_HISTORY_PROVIDER");
    await using fixture = await ClaudeFixture.create(provider);
    await withRealDaemon(signal, new ClaudeCodeAgentSpecification(), fixture.environment, async (peer) => {
        const home = fixture.environment["CLAUDE_CONFIG_DIR"];
        if (home === undefined) {
            throw new Error("Expected an isolated Claude configuration directory");
        }
        const nativeId = randomUUID();
        const project = join(home, "projects", peer.workspace.replace(/[^a-zA-Z0-9]/g, "-"));
        await mkdir(project, { recursive: true });
        // Retain the old transcript representation independently of the new formatter.
        const uri = "attachment:///index.html";
        const context = `\n<context ref="${uri}">\nSaved context\n</context>`;
        const otherUri = "attachment:///notes.md";
        const otherContext = `\n<context ref="${otherUri}">\nSaved notes\n</context>`;
        const unchanged = [
            ["This is quoted mid-message:", context, "And this follows it"],
            ['User typed <context ref="x">not an attachment</context> here'],
            [uri],
            [context],
            [otherUri, context],
            [otherUri, uri, context, otherContext],
            [uri, uri, context],
            [uri, otherUri, `\n<context ref="${uri}">\nUnclosed context`, otherContext],
            [uri, `${context}\n`],
        ].map((texts) => ({ messageId: randomUUID(), texts }));
        const resources = [
            { uri, text: `<html>${"x".repeat(1_200_000)}</html>`, mimeType: "text/html" },
            { uri: otherUri, text: "# Notes", mimeType: "text/markdown" },
            { uri, text: "A second attachment with the same URI", mimeType: "text/html" },
            { uri: "attachment:///data.json", text: '{"ok":true}', mimeType: "application/json" },
        ];
        const image = Buffer.concat([
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
            ),
            Buffer.alloc(1_200_000),
        ]);
        const attachmentMessageId = randomUUID();
        const messages = [
            ...unchanged.map(({ messageId, texts }) => ({
                messageId,
                content: texts.map((text) => ({ type: "text", text })),
            })),
            {
                messageId: attachmentMessageId,
                content: [
                    { type: "text", text: "Read these attachments" },
                    ...resources.map(({ uri }) => ({ type: "text", text: uri })),
                    {
                        type: "image",
                        source: { type: "base64", data: image.toString("base64"), media_type: "image/png" },
                    },
                    ...resources.map(({ uri, text }) => ({
                        type: "text",
                        text: `\n<context ref="${uri}">\n${text}\n</context>`,
                    })),
                ],
            },
        ];
        let parentUuid: string | null = null;
        const records = messages.map(({ messageId: uuid, content }) => {
            const record = {
                uuid,
                parentUuid,
                sessionId: nativeId,
                type: "user",
                isSidechain: false,
                cwd: peer.workspace,
                version: "2.1.273",
                timestamp: "2026-10-27T09:40:15.123Z",
                message: { role: "user", content },
            };
            parentUuid = uuid;
            return JSON.stringify(record);
        });
        await writeFile(join(project, `${nativeId}.jsonl`), `${records.join("\n")}\n`);
        peer.send(
            encodeSessionPreviewHistoryPageLoad({
                directory: ".",
                cursor: null,
                eventLimit: 50,
                kind: "session.preview-history.page.load",
                requestId: "claude-attachment-preview",
                target: { harness: "claude", sessionId: nativeId },
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind !== "session.preview-history.page.loaded") {
                continue;
            }
            const result = decodeSessionPreviewHistoryPageLoaded(message);
            const chunks = result.events.events.events.flatMap((event) =>
                event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk" ? [event.payload] : [],
            );
            for (const { messageId, texts } of unchanged) {
                expect(chunks.filter((chunk) => chunk.messageId === messageId).map((chunk) => chunk.content)).toEqual([
                    { type: "text", text: texts.join("") },
                ]);
            }
            const restored = chunks.filter((chunk) => chunk.messageId === attachmentMessageId);
            expect(restored.slice(0, 2).map((chunk) => chunk.content)).toEqual([
                { type: "text", text: `Read these attachments${resources.map(({ uri }) => uri).join("")}` },
                {
                    type: "external_image",
                    imageKey: createHash("sha256").update(image).digest("hex"),
                    byteLength: image.byteLength,
                    mimeType: "image/png",
                },
            ]);
            const contextChunks = restored.slice(2).map((chunk) => chunk.content);
            expect(contextChunks.every((content) => content.type === "text")).toBe(true);
            expect(contextChunks.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("")).toBe(
                resources
                    .map(({ uri, text }, index) => {
                        const context = `\n<context ref="${uri}">\n${text}\n</context>`;
                        // Historical context now follows the existing plain-text delivery bound.
                        return index === 0
                            ? `${context.slice(0, 999_959)}... [omit ${context.length - 999_959} characters since 999959]`
                            : context;
                    })
                    .join(""),
            );
            break;
        }
    });
});
