import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    decodeContentChunkFrame,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    decodeSessionOperationFailedEvent,
    decodeSessionPromptCommand,
    decodeSessionReadyEvent,
    encodeFileReadCommand,
    encodeNativeSessionCommand,
    encodeSessionCancelCommand,
    encodeSessionCreateCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    MORTY_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_CANCEL_KIND,
    SESSION_EVENT_KIND,
    SESSION_HISTORY_PAGE_LOADED_KIND,
    SESSION_OPERATION_FAILED_KIND,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { createRuntimeConfig, RuntimeAgentDependencies, RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { testAgentDefinition } from "../support/agent-definition.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createEncryptedDaemonGateway, type EncryptedDaemonPeer } from "../support/encrypted-daemon-gateway.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given real Codex streams commentary after a tool, When clients watch and reopen the completed Session, Then commentary remains assistant output in chronological history", async () => {
    let providerEntered = Promise.withResolvers<void>();
    let releaseProvider = Promise.withResolvers<void>();
    const provider = await FakeOpenAiProvider.start("morty-test-model", "Codex live reply", {
        commentary: "Checking the live progress boundary.",
        beforeFirstText: async () => {
            providerEntered.resolve();
            await releaseProvider.promise;
        },
    });
    const codex = await CodexFixture.create(provider);
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-real-codex-live-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const gateway = await createEncryptedDaemonGateway(stateDirectory, "real-codex", AbortSignal.timeout(120_000));
    const connected = Promise.withResolvers<EncryptedDaemonPeer>();
    websocketServer.on("connection", (socket) => connected.resolve(gateway.connect(socket)));
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay).toString()}${MORTY_API_PREFIX}/channels/real-codex/daemon`);
    const agent = testAgentDefinition("codex", "Codex", codex.executable, codex.environment);
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "real-codex",
            defaultWorkspace: workspace,
            relayUrl,
        },
        new RuntimeAgentDependencies([agent]),
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);

    try {
        const socket = await connected.promise;
        const messages = socket;
        socket.send(
            encodeSessionCreateCommand({
                kind: "session.create",
                requestId: randomUUID(),
                operationId: randomUUID(),
                harness: "codex",
                directory: ".",
                configurations: [],
            }),
        );
        let created = await messages.next();
        while (decodeMessageKind(created) !== "session.ready") {
            if (decodeMessageKind(created) === "session.operation.failed") {
                throw new Error(created);
            }
            created = await messages.next();
        }
        const sessionTarget = decodeSessionReadyEvent(created).target;
        for (const _turnNumber of [1, 2]) {
            providerEntered = Promise.withResolvers<void>();
            releaseProvider = Promise.withResolvers<void>();
            const commandId = randomUUID();
            const queuedCommandId = randomUUID();
            const originalPrompt = encodeSessionPromptCommand({
                commandId,
                requestId: commandId,
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "Use a shell tool successfully, then reply using the configured model",
                target: sessionTarget,
            });
            socket.send(originalPrompt);
            let started = false;
            let completed = false;
            let sequence = 0;
            let thought = "";
            let snapshotVerified = false;
            let queuedCancelled = false;
            let queuedAdmitted = false;
            let text = "";

            while (!completed) {
                const message = await messages.next();
                if (
                    decodeMessageKind(message) === SESSION_EVENT_KIND &&
                    decodeSessionEventEnvelope(message).events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed",
                    ) === true &&
                    queuedAdmitted === false
                ) {
                    queuedAdmitted = true;
                    socket.send(
                        encodeNativeSessionCommand({
                            action: "active-turn",
                            kind: "native.session.request",
                            requestId: "queued_snapshot",
                            target: sessionTarget,
                        }),
                    );
                    continue;
                }
                if (decodeMessageKind(message) === NATIVE_SESSION_RESULT_KIND) {
                    const result = decodeNativeSessionResult(message);
                    if (result.requestId === "queued_snapshot") {
                        expect(result).toMatchObject({
                            queued: [
                                {
                                    attachments: [],
                                    commandId: queuedCommandId,
                                    prompt: "This queued prompt should not run",
                                },
                            ],
                        });
                        socket.send(
                            encodeSessionCancelCommand({
                                commandId: queuedCommandId,
                                kind: SESSION_CANCEL_KIND,
                                requestId: crypto.randomUUID(),
                                target: sessionTarget,
                            }),
                        );
                        continue;
                    }
                    expect(result).toMatchObject({ queued: [] });
                    expect(result.action).toBe("active-turn");
                    if (result.action === "active-turn") {
                        expect(result.turn).toMatchObject({
                            commandId,
                            epoch: expect.any(String),
                            state: "running",
                        });
                    }
                    snapshotVerified = true;
                    socket.send(
                        encodeSessionHistoryPageLoad({
                            kind: "session.live-history.v2.page.load",
                            requestId: randomUUID(),
                            target: sessionTarget,
                            cursor: null,
                            eventLimit: 200,
                        }),
                    );
                    continue;
                }
                if (decodeMessageKind(message) === SESSION_HISTORY_PAGE_LOADED_KIND) {
                    const recovered = decodeSessionHistoryPageLoaded(message).events;
                    expect(
                        recovered.events.events.some(
                            (event) => event.type === "acp" && event.payload.sessionUpdate === "tool_call",
                        ),
                    ).toBe(true);
                    releaseProvider.resolve();
                    continue;
                }
                if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                    continue;
                }
                for (const event of decodeSessionEventEnvelope(message).events) {
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.started") {
                        expect(started).toBe(false);
                        expect(event.payload).toMatchObject({
                            commandId,
                            epoch: expect.any(String),
                        });
                        started = true;
                        await providerEntered.promise;
                        socket.send(
                            encodeSessionPromptCommand({
                                commandId: queuedCommandId,
                                requestId: queuedCommandId,
                                disposition: SessionPromptDisposition.Append,
                                attachments: [],
                                kind: "session.prompt",
                                prompt: "This queued prompt should not run",
                                target: sessionTarget,
                            }),
                        );
                    } else if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        expect(started).toBe(true);
                        expect(Number(event.position)).toBeGreaterThan(sequence);
                        sequence = Number(event.position);
                        text += event.payload.content.text;
                    } else if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_thought_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        thought += event.payload.content.text;
                    } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        const completion = event.payload;
                        if (completion.commandId === queuedCommandId) {
                            expect(completion.stopReason).toBe("cancelled");
                            queuedCancelled = true;
                            socket.send(
                                encodeNativeSessionCommand({
                                    action: "active-turn",
                                    kind: "native.session.request",
                                    requestId: randomUUID(),
                                    target: sessionTarget,
                                }),
                            );
                        } else {
                            expect(completion.commandId).toBe(commandId);
                            expect(queuedCancelled).toBe(true);
                            completed = true;
                        }
                    } else if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        throw new Error(`Real Codex Turn failed: ${JSON.stringify(event)}`);
                    }
                }
            }
            expect(started).toBe(true);
            expect(queuedCancelled).toBe(true);
            expect(snapshotVerified).toBe(true);
            expect(sequence).toBeGreaterThan(0);
            expect(text).toContain("Checking the live progress boundary.");
            expect(text).toContain("Codex live reply");
            expect(thought).toBe("");
            const originalCommand = decodeSessionPromptCommand(originalPrompt);
            socket.send(JSON.stringify(Object.fromEntries(Object.entries(originalCommand).reverse())));
            socket.send(
                encodeSessionPromptCommand({ ...originalCommand, prompt: "Conflicting reuse must not execute" }),
            );
            // The retry restates the settled outcome without running again; the conflicting reuse is refused.
            let restated = false;
            let refused = false;
            while (!restated || !refused) {
                const message = await messages.next();
                if (decodeMessageKind(message) === SESSION_EVENT_KIND) {
                    for (const event of decodeSessionEventEnvelope(message).events) {
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.started") {
                            throw new Error(`A retried command started again: ${JSON.stringify(event)}`);
                        }
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                            expect(event.payload.commandId).toBe(commandId);
                            expect(event.mortyMetadata).toEqual({ restated: true });
                            restated = true;
                        }
                    }
                    continue;
                }
                if (decodeMessageKind(message) !== SESSION_OPERATION_FAILED_KIND) {
                    continue;
                }
                expect(decodeSessionOperationFailedEvent(message)).toMatchObject({
                    requestId: commandId,
                    target: sessionTarget,
                    code: "command_identity_conflict",
                });
                refused = true;
            }
            socket.send(
                encodeSessionHistoryPageLoad({
                    kind: "session.live-history.v2.page.load",
                    requestId: randomUUID(),
                    target: sessionTarget,
                    cursor: null,
                    eventLimit: 200,
                }),
            );
            for (;;) {
                const message = await messages.next();
                if (decodeMessageKind(message) !== SESSION_HISTORY_PAGE_LOADED_KIND) {
                    continue;
                }
                const page = decodeSessionHistoryPageLoaded(message).events.events;
                const updates = page.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
                const toolUpdates = updates.filter(
                    (update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update",
                );
                const toolIndex = updates.findIndex(
                    (update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update",
                );
                const commentaryIndex = updates.findIndex(
                    (update) =>
                        update.sessionUpdate === "agent_message_chunk" &&
                        update.content.type === "text" &&
                        updates.indexOf(update) > toolIndex,
                );
                const finalIndex = updates.findIndex(
                    (update) =>
                        update.sessionUpdate === "agent_message_chunk" &&
                        update.content.type === "text" &&
                        update.content.text.includes("Codex live reply"),
                );
                const commentary = updates
                    .slice(commentaryIndex, finalIndex)
                    .flatMap((update) =>
                        update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
                            ? [update.content.text]
                            : [],
                    )
                    .join("");
                expect(toolUpdates).toHaveLength(1);
                expect(toolUpdates[0]?.sessionUpdate).toBe("tool_call");
                expect(commentary).toBe("Checking the live progress boundary.");
                expect(toolIndex).toBeGreaterThanOrEqual(0);
                expect(commentaryIndex).toBeGreaterThan(toolIndex);
                expect(finalIndex).toBeGreaterThan(commentaryIndex);
                break;
            }
        }
        const image = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
        );
        await writeFile(join(workspace, "badge.png"), image);
        socket.send(
            encodeFileReadCommand({
                kind: "file.read",
                requestId: randomUUID(),
                target: sessionTarget,
                path: "badge.png",
                maxBytes: 1024,
            }),
        );
        const chunks: Buffer[] = [];
        for (;;) {
            const message = await messages.nextFrame();
            if (typeof message !== "string") {
                chunks.push(Buffer.from(decodeContentChunkFrame(message).bytes));
                continue;
            }
            const kind = decodeMessageKind(message);
            expect(kind).not.toBe(FILE_FAILED_KIND);
            if (kind === FILE_END_KIND) {
                break;
            }
        }
        expect(Buffer.concat(chunks)).toEqual(image);
    } finally {
        releaseProvider.resolve();
        cancellation.abort();
        await runtime;
        await gateway.close();
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { force: true, recursive: true });
        await codex[Symbol.asyncDispose]();
        await provider[Symbol.asyncDispose]();
    }
}, 120_000);
