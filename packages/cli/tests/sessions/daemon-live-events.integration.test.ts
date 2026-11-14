import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeContentAvailableEvent,
    decodeContentReadyEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    decodeSessionReadyEvent,
    encodeContentChunkFrame,
    encodeContentCommitCommand,
    encodeContentWriteCommand,
    encodeNativeSessionRequest,
    encodeSessionCancelCommand,
    encodeSessionCreateCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    MORTY_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    type NativeSessionTarget,
    type PromptAttachment,
    SESSION_EVENT_KIND,
    SESSION_HISTORY_PAGE_LOADED_KIND,
    type SessionEvent,
    type SessionLiveEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { SESSION_EVENT_BATCH_WINDOW_MILLISECONDS } from "../../src/engine/runtime/relay/session-event-publisher.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import type { ScheduledTask, Timer } from "../../src/engine/util/timer.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../support/controlled-runtime-config.ts";
import { createEncryptedDaemonGateway, type EncryptedDaemonPeer } from "../support/encrypted-daemon-gateway.ts";

const sendText = (peer: EncryptedDaemonPeer, message: string) => peer.send(message);
const sendBinary = (peer: EncryptedDaemonPeer, message: Uint8Array) => peer.send(message);
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class ControllableDaemonTask implements ScheduledTask {
    #cancelled = false;
    readonly #callback: () => void;

    constructor(callback: () => void) {
        this.#callback = callback;
    }

    readonly cancel = (): void => {
        this.#cancelled = true;
    };

    readonly isPending = (): boolean => !this.#cancelled;

    readonly run = (): void => {
        if (!this.#cancelled) {
            this.#cancelled = true;
            this.#callback();
        }
    };
}

class ControllableTimer implements Timer {
    readonly batchWindowMilliseconds: number[] = [];
    readonly #scheduled: ControllableDaemonTask[] = [];
    readonly #waiters: Array<(task: ControllableDaemonTask) => void> = [];

    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        const task = new ControllableDaemonTask(callback);
        if (milliseconds !== SESSION_EVENT_BATCH_WINDOW_MILLISECONDS) {
            return task;
        }
        this.batchWindowMilliseconds.push(milliseconds);
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#scheduled.push(task);
        } else {
            waiter(task);
        }
        return task;
    };

    readonly nextBatch = (signal: AbortSignal): Promise<ControllableDaemonTask> => {
        signal.throwIfAborted();
        // A flush cancels the batch it sends early; only a pending batch can still deliver events.
        let task = this.#scheduled.shift();
        while (task !== undefined && !task.isPending()) {
            task = this.#scheduled.shift();
        }
        if (task !== undefined) {
            return Promise.resolve(task);
        }
        return new Promise((resolve, reject) => {
            const ready = (scheduled: ControllableDaemonTask): void => {
                signal.removeEventListener("abort", abort);
                resolve(scheduled);
            };
            const abort = (): void => {
                const index = this.#waiters.indexOf(ready);
                if (index !== -1) {
                    this.#waiters.splice(index, 1);
                }
                reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
            this.#waiters.push(ready);
        });
    };
}

class ClientFrames {
    readonly #messages: string[] = [];
    readonly #peer: EncryptedDaemonPeer;

    constructor(peer: EncryptedDaemonPeer) {
        this.#peer = peer;
    }

    readonly next = (signal?: AbortSignal): Promise<string> => {
        signal?.throwIfAborted();
        const buffered = this.#messages.shift();
        if (buffered !== undefined) {
            return Promise.resolve(buffered);
        }
        return this.#peer.next(signal);
    };
    readonly prepend = (frames: readonly string[]): void => {
        this.#messages.unshift(...frames);
    };
}

async function startControlledDaemon(options: { readonly stateDirectory?: string } = {}): Promise<{
    readonly agent: AcpAgentDefinition;
    readonly close: () => Promise<void>;
    readonly config: ReturnType<typeof createRuntimeConfig>;
    readonly frames: ClientFrames;
    readonly liveBatchSizes: number[];
    readonly socket: EncryptedDaemonPeer;
    readonly timer: ControllableTimer;
    readonly sessionTarget: NativeSessionTarget;
}> {
    const ownsStateDirectory = options.stateDirectory === undefined;
    const stateDirectory = options.stateDirectory ?? (await mkdtemp(join(tmpdir(), "morty-daemon-timeline-")));
    const workspace = join(stateDirectory, "workspace");
    const nativeStateDirectory = join(stateDirectory, "native");
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(nativeStateDirectory, { recursive: true })]);
    const gateway = await createEncryptedDaemonGateway(stateDirectory, "channel_alpha", AbortSignal.timeout(120_000));
    const socketReady = Promise.withResolvers<EncryptedDaemonPeer>();
    const relay = createServer((_request, response) => {
        response.writeHead(404);
        response.end();
    });
    const relaySockets = new WebSocketServer({ server: relay });
    relaySockets.on("connection", (socket) => socketReady.resolve(gateway.connect(socket)));
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/channel_alpha/daemon`);
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "controlled-acp",
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Controlled ACP"],
                    environment: options.environment,
                },
                options,
            ),
        "controlled-acp",
        "Controlled ACP",
        process.execPath,
        { MORTY_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
    );
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "channel_alpha",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const cancellation = new AbortController();
    const timer = new ControllableTimer();
    const runtime = runRuntime(config, cancellation.signal, timer);
    const socket = await socketReady.promise;
    const frames = new ClientFrames(socket);
    await sendText(
        socket,
        encodeSessionCreateCommand({
            kind: "session.create",
            requestId: "fixture-create",
            operationId: "fixture-creation",
            harness: agent.harness,
            directory: ".",
            configurations: [],
        }),
    );
    let created = await frames.next();
    const initialFrames: string[] = [];
    while (decodeMessageKind(created) !== "session.ready") {
        if (decodeMessageKind(created) === "session.operation.failed") {
            throw new Error(created);
        }
        initialFrames.push(created);
        created = await frames.next();
    }
    frames.prepend(initialFrames);
    const sessionTarget = decodeSessionReadyEvent(created).target;
    return {
        agent,
        config,
        frames,
        sessionTarget,
        liveBatchSizes: [],
        socket,
        timer,
        close: async () => {
            cancellation.abort();
            await runtime;
            await gateway.close();
            await new Promise<void>((resolve) => relaySockets.close(() => resolve()));
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            if (ownsStateDirectory) {
                await rm(stateDirectory, { force: true, recursive: true });
            }
        },
    };
}

type Fixture = Awaited<ReturnType<typeof startControlledDaemon>>;
const pendingLiveEvents = new WeakMap<Fixture, SessionLiveEvent[]>();

async function uploadTextAttachment(fixture: Fixture, text: string): Promise<PromptAttachment> {
    const bytes = new TextEncoder().encode(text);
    const contentKey = createHash("sha256").update(bytes).digest("hex");
    const requestId = randomUUID();
    await sendText(
        fixture.socket,
        encodeContentWriteCommand({
            byteLength: bytes.byteLength,
            contentKey,
            contentKind: "resource",
            kind: "content.write",
            mediaType: "text/plain",
            name: "context.txt",
            requestId,
            target: fixture.sessionTarget,
        }),
    );
    let ready = await fixture.frames.next();
    while (decodeMessageKind(ready) !== "content.ready") {
        ready = await fixture.frames.next();
    }
    expect(decodeContentReadyEvent(ready).requestId).toBe(requestId);
    await sendBinary(fixture.socket, encodeContentChunkFrame({ bytes, requestId, sequence: 0 }));
    await sendText(
        fixture.socket,
        encodeContentCommitCommand({ kind: "content.commit", requestId, target: fixture.sessionTarget }),
    );
    let available = await fixture.frames.next();
    while (decodeMessageKind(available) !== "content.available") {
        available = await fixture.frames.next();
    }
    expect(decodeContentAvailableEvent(available).contentKey).toBe(contentKey);
    return {
        byteLength: bytes.byteLength,
        contentKey,
        kind: "resource",
        mimeType: "text/plain",
        name: "context.txt",
        uri: "attachment:///context.txt",
    };
}

function prompt(fixture: Fixture, text: string): SessionPromptCommand {
    return {
        commandId: "test-turn",
        requestId: "test-turn",
        disposition: SessionPromptDisposition.Append,
        attachments: [],
        kind: "session.prompt",
        prompt: text,
        target: fixture.sessionTarget,
    };
}
async function nextLive(fixture: Fixture, allowPromptFailure = false): Promise<SessionLiveEvent> {
    const pending = pendingLiveEvents.get(fixture) ?? [];
    const buffered = pending.shift();
    if (buffered !== undefined) {
        return buffered;
    }
    for (;;) {
        const advanceSignal = new AbortController();
        const pendingFrame = fixture.frames.next();
        const advancing = fixture.timer.nextBatch(advanceSignal.signal).then(
            (task) => task.run(),
            (error: unknown) => {
                if (!advanceSignal.signal.aborted) {
                    throw error;
                }
            },
        );
        let frame: string;
        try {
            frame = await Promise.race([pendingFrame, advancing.then(() => pendingFrame)]);
        } finally {
            advanceSignal.abort();
            await advancing;
        }
        expect(decodeMessageKind(frame)).not.toBe("session.event");
        if (decodeMessageKind(frame) === "session.operation.failed") {
            throw new Error(frame);
        }
        if (decodeMessageKind(frame) !== SESSION_EVENT_KIND) {
            continue;
        }
        const events = [...decodeSessionEventEnvelope(frame).events];
        fixture.liveBatchSizes.push(events.length);
        const failure = events.find(
            (event) =>
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start"),
        );
        if (failure !== undefined && !allowPromptFailure) {
            throw new Error(frame);
        }
        const event = events.shift();
        if (event !== undefined) {
            pendingLiveEvents.set(fixture, events);
            return event;
        }
    }
}
async function cancel(fixture: Fixture, command: SessionPromptCommand): Promise<void> {
    await sendText(
        fixture.socket,
        encodeSessionCancelCommand({
            kind: "session.cancel",
            requestId: crypto.randomUUID(),
            commandId: command.commandId,
            target: command.target,
        }),
    );
    for (;;) {
        const event = await nextLive(fixture);
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
            expect(event.payload.completion).toMatchObject({ kind: "cancelled" });
            return;
        }
    }
}
/** The turn lifecycle a history page holds, in page order. */
const turnLifecycle = (events: readonly SessionEvent[]): readonly string[] =>
    events.flatMap((event) =>
        event.type === "lifecycle-metadata" && "commandId" in event.payload
            ? [`${event.payload.kind} ${event.payload.commandId}`]
            : [],
    );

async function history(
    fixture: Fixture,
    command: SessionPromptCommand,
    options: {
        readonly cursor?: string | null;
        readonly eventLimit?: number;
    } = {},
) {
    await sendText(
        fixture.socket,
        encodeSessionHistoryPageLoad({
            kind: "session.live-history.v2.page.load",
            requestId: "history",
            target: command.target,
            cursor: options.cursor ?? null,
            eventLimit: options.eventLimit ?? 200,
        }),
    );
    for (;;) {
        const frame = await fixture.frames.next();
        if (decodeMessageKind(frame) === "session.operation.failed") {
            throw new Error(frame);
        }
        if (decodeMessageKind(frame) === SESSION_HISTORY_PAGE_LOADED_KIND) {
            return decodeSessionHistoryPageLoaded(frame).events.events;
        }
    }
}
async function activeTurn(fixture: Fixture, command: SessionPromptCommand) {
    await sendText(
        fixture.socket,
        encodeNativeSessionRequest({
            action: "active-turn",
            kind: "native.session.request",
            requestId: "active",
            target: command.target,
        }),
    );
    for (;;) {
        const frame = await fixture.frames.next();
        if (decodeMessageKind(frame) !== NATIVE_SESSION_RESULT_KIND) {
            continue;
        }
        const result = decodeNativeSessionResult(frame);
        if (result.action !== "active-turn") {
            throw new Error("Expected active turn");
        }
        return result.turn;
    }
}
describe("daemon V2 live delivery", () => {
    it.each(["user_message_chunk", "agent_message_chunk"])(
        "Given consecutive %s blocks cross the wire bound, When a viewer loads history, Then exact-limit merges remain valid and overflow text is retained in order without cutting Unicode",
        async (sessionUpdate) => {
            const fixture = await startControlledDaemon();
            try {
                const command = prompt(fixture, `stream merged text ${sessionUpdate}`);
                await sendText(fixture.socket, encodeSessionPromptCommand(command));
                for (;;) {
                    const event = await nextLive(fixture);
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        break;
                    }
                }
                const page = await history(fixture, command);
                const chunks = page.events.flatMap((event) =>
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "user_message_chunk" ||
                        event.payload.sessionUpdate === "agent_message_chunk") &&
                    event.payload.messageId === "merged-message"
                        ? [event.payload]
                        : [],
                );
                expect(chunks).toEqual(
                    [
                        `${"a".repeat(500_000)}${"b".repeat(500_000)}`,
                        `\u{1f600}${"c".repeat(499_999)}`,
                        "d".repeat(500_000),
                    ].map((text) => ({ sessionUpdate, messageId: "merged-message", content: { type: "text", text } })),
                );
            } finally {
                await fixture.close();
            }
        },
    );

    it("Given a stored conversation has valid user blocks totaling 1666038 characters, When it reopens after restart, Then paginated history retains all text and a follow-up continues the same native session", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-large-saved-history-"));
        try {
            const first = await startControlledDaemon({ stateDirectory });
            try {
                await sendText(first.socket, encodeSessionPromptCommand(prompt(first, "Seed saved conversation")));
                for (;;) {
                    const event = await nextLive(first);
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        break;
                    }
                }
            } finally {
                await first.close();
            }
            const nativeDirectory = join(stateDirectory, "native");
            const nativeFiles = (await readdir(nativeDirectory)).filter((name) => name.endsWith(".json"));
            expect(nativeFiles).toHaveLength(1);
            const nativeFile = nativeFiles[0];
            if (nativeFile === undefined) {
                throw new Error("Missing saved native session");
            }
            const nativePath = join(nativeDirectory, nativeFile);
            const state = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(nativePath, "utf8")));
            const blocks = [6, 24, 24, 24, 24, 10_169, 551_920, 551_924, 551_923].map((length, index) =>
                `${index}:`.padEnd(length, String(index)),
            );
            expect(blocks.join("")).toHaveLength(1_666_038);
            const saved = JSON.stringify({
                ...state,
                history: [
                    ...blocks.map((text) => ({ messageId: "saved-user", role: "user", text })),
                    { messageId: "saved-answer", role: "assistant", text: "The saved answer" },
                ],
            });
            await writeFile(nativePath, saved);

            const restarted = await startControlledDaemon({ stateDirectory });
            try {
                const command = {
                    ...prompt(restarted, "Continue the saved conversation"),
                    commandId: "continue-saved-conversation",
                    requestId: "continue-saved-conversation",
                };
                const events: SessionEvent[] = [];
                let cursor: string | null = null;
                do {
                    const page = await history(restarted, command, { cursor, eventLimit: 1 });
                    expect(page.events).toHaveLength(1);
                    events.unshift(...page.events);
                    cursor = page.nextCursor;
                } while (cursor !== null);
                expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
                const userChunks = events.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [{ messageId: event.payload.messageId, text: event.payload.content.text }]
                        : [],
                );
                expect(userChunks).toHaveLength(3);
                expect(userChunks.every((chunk) => chunk.messageId === "saved-user")).toBe(true);
                expect(userChunks.every((chunk) => chunk.text.length <= 1_000_000)).toBe(true);
                expect(userChunks.map((chunk) => chunk.text).join("")).toBe(blocks.join(""));
                expect(events).toContainEqual(
                    expect.objectContaining({
                        payload: expect.objectContaining({
                            messageId: "saved-answer",
                            content: { type: "text", text: "The saved answer" },
                        }),
                    }),
                );
                expect((await history(restarted, command)).events).toEqual(events);
                expect(await readFile(nativePath, "utf8")).toBe(saved);
                await sendText(restarted.socket, encodeSessionPromptCommand(command));
                for (;;) {
                    const event = await nextLive(restarted);
                    if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === command.commandId
                    ) {
                        break;
                    }
                }
                expect((await readdir(nativeDirectory)).filter((name) => name.endsWith(".json"))).toEqual(nativeFiles);
                const continued = z
                    .object({
                        turnCount: z.number(),
                        history: z.array(z.object({ messageId: z.string(), text: z.string() })),
                    })
                    .parse(JSON.parse(await readFile(nativePath, "utf8")));
                expect(continued.turnCount).toBe(2);
                expect(
                    continued.history.filter((message) => message.messageId === "saved-user").map((m) => m.text),
                ).toEqual(blocks);
                expect(continued.history).toContainEqual({ messageId: "user-2", text: command.prompt });
            } finally {
                await restarted.close();
            }
        } finally {
            await rm(stateDirectory, { recursive: true, force: true });
        }
    });

    it.each(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "compaction_summary_chunk"])(
        "Given oversized %s text, When the daemon publishes and replays it, Then text is bounded with an exact omission marker and the turn completes",
        async (sessionUpdate) => {
            const fixture = await startControlledDaemon();
            try {
                const command = prompt(fixture, `stream bounded text ${sessionUpdate}`);
                await sendText(fixture.socket, encodeSessionPromptCommand(command));
                const chunks: SessionLiveEvent[] = [];
                for (;;) {
                    const event = await nextLive(fixture);
                    if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === sessionUpdate &&
                        (("messageId" in event.payload &&
                            ["at-limit", "over-limit", "unicode-limit"].includes(event.payload.messageId)) ||
                            "compactionId" in event.payload)
                    ) {
                        chunks.push(event);
                    }
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        break;
                    }
                }
                expect(chunks.map((event) => event.payload)).toEqual([
                    {
                        sessionUpdate,
                        ...(sessionUpdate === "compaction_summary_chunk"
                            ? { compactionId: "at-limit" }
                            : { messageId: "at-limit" }),
                        content: { type: "text", text: "a".repeat(1_000_000) },
                    },
                    {
                        sessionUpdate,
                        ...(sessionUpdate === "compaction_summary_chunk"
                            ? { compactionId: "over-limit" }
                            : { messageId: "over-limit" }),
                        content: {
                            type: "text",
                            text: `${"b".repeat(999_962)}... [omit 138 characters since 999962]`,
                        },
                    },
                    {
                        sessionUpdate,
                        ...(sessionUpdate === "compaction_summary_chunk"
                            ? { compactionId: "unicode-limit" }
                            : { messageId: "unicode-limit" }),
                        content: {
                            type: "text",
                            text: `${"c".repeat(999_961)}... [omit 139 characters since 999961]`,
                        },
                    },
                ]);
                const page = await history(fixture, command);
                const replay = page.events.filter((event) => chunks.some((chunk) => chunk.eventId === event.eventId));
                expect(replay.map((event) => ({ eventId: event.eventId, payload: event.payload }))).toEqual(
                    chunks.map((event) => ({
                        eventId: event.eventId,
                        payload:
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_thought_chunk" &&
                            event.payload.content.type === "text"
                                ? {
                                      ...event.payload,
                                      content: { type: "text", text: event.payload.content.text.slice(-24 * 1024) },
                                      meta: { truncated: true },
                                  }
                                : event.payload,
                    })),
                );
            } finally {
                await fixture.close();
            }
        },
    );

    it("Given a harness identifies a user message and fails its prompt, When the daemon publishes the failure, Then the failure names the user message it recorded", async () => {
        const fixture = await startControlledDaemon();
        try {
            await sendText(fixture.socket, encodeSessionPromptCommand(prompt(fixture, "fail with model unavailable")));
            const events: SessionLiveEvent[] = [];
            for (;;) {
                const event = await nextLive(fixture, true);
                events.push(event);
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    expect(event.payload).toMatchObject({ messageId: "user-1" });
                    break;
                }
            }
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: "acp",
                    payload: expect.objectContaining({ sessionUpdate: "user_message_chunk", messageId: "user-1" }),
                }),
            );
        } finally {
            await fixture.close();
        }
    });

    it("Given a running turn with a queued follow-up, When another prompt steers the turn, Then history retains executed user messages once with their turns' lifecycle and omits queue lifecycle metadata", async () => {
        const fixture = await startControlledDaemon();
        try {
            const running = prompt(fixture, "wait for steering");
            const userMessageIds: string[] = [];
            await sendText(fixture.socket, encodeSessionPromptCommand(running));
            for (;;) {
                const event = await nextLive(fixture);
                if (event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk") {
                    userMessageIds.push(event.payload.messageId);
                }
                if (event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk") {
                    break;
                }
            }
            const queued: SessionPromptCommand = {
                ...running,
                commandId: "queued-follow-up",
                requestId: "queued-follow-up",
                disposition: SessionPromptDisposition.Append,
                prompt: "Execute the queued follow-up",
            };
            await sendText(fixture.socket, encodeSessionPromptCommand(queued));
            for (;;) {
                const event = await nextLive(fixture);
                if (event.type === "lifecycle-metadata" && event.payload.kind === "session.queue.changed") {
                    break;
                }
            }
            const pending = await history(fixture, running);
            expect(turnLifecycle(pending.events)).toEqual([
                `prompt.requested ${running.commandId}`,
                `prompt.started ${running.commandId}`,
            ]);
            expect(
                pending.events.flatMap((event) =>
                    event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk"
                        ? [event.payload.messageId]
                        : [],
                ),
            ).toEqual([userMessageIds[0]]);

            const steering: SessionPromptCommand = {
                ...running,
                commandId: "steering-follow-up",
                requestId: "steering-follow-up",
                disposition: SessionPromptDisposition.Steer,
                prompt: "Finish using the steering instruction",
                targetCommandId: running.commandId,
            };
            await sendText(fixture.socket, encodeSessionPromptCommand(steering));
            const completed = new Set<string>();
            while (completed.size < 3) {
                const event = await nextLive(fixture);
                if (event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk") {
                    userMessageIds.push(event.payload.messageId);
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    completed.add(event.payload.commandId);
                }
            }
            expect(completed).toEqual(new Set([running.commandId, steering.commandId, queued.commandId]));
            const page = await history(fixture, running);
            expect(turnLifecycle(page.events)).toEqual(
                expect.arrayContaining([
                    `prompt.completed ${running.commandId}`,
                    `prompt.completed ${steering.commandId}`,
                    `prompt.completed ${queued.commandId}`,
                ]),
            );
            expect(
                page.events.flatMap((event) =>
                    event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk" ? [event.payload] : [],
                ),
            ).toEqual(
                [running, steering, queued].map((command, index) => ({
                    content: { text: command.prompt, type: "text" },
                    messageId: userMessageIds[index],
                    sessionUpdate: "user_message_chunk",
                })),
            );
            expect(await activeTurn(fixture, running)).toBeNull();
        } finally {
            await fixture.close();
        }
    });

    it.each(["text-only", "with attachment"])(
        "Given a %s prompt publishes lifecycle metadata, When a viewer reads history after completion, Then the prompt appears once as ACP content inside its turn's lifecycle",
        async (scenario) => {
            const fixture = await startControlledDaemon();
            try {
                const command: SessionPromptCommand = {
                    ...prompt(fixture, "stream token burst"),
                    attachments:
                        scenario === "text-only" ? [] : [await uploadTextAttachment(fixture, "attached context")],
                };
                await sendText(fixture.socket, encodeSessionPromptCommand(command));
                const live: SessionLiveEvent[] = [];
                for (;;) {
                    const event = await nextLive(fixture);
                    live.push(event);
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        break;
                    }
                }
                const lifecycleKinds = live.flatMap((event) =>
                    event.type === "lifecycle-metadata" ? [event.payload.kind] : [],
                );
                expect(lifecycleKinds).toEqual(
                    expect.arrayContaining(["prompt.requested", "prompt.started", "prompt.completed"]),
                );
                const completed = live.find(
                    (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
                );
                expect(completed?.payload).toMatchObject({ messageId: "user-1" });

                const page = await history(fixture, command);
                expect(page.events.length).toBeGreaterThan(0);
                expect(turnLifecycle(page.events)).toEqual([
                    `prompt.requested ${command.commandId}`,
                    `prompt.started ${command.commandId}`,
                    `prompt.completed ${command.commandId}`,
                ]);
                const userMessages = page.events.flatMap((event) =>
                    event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk" ? [event] : [],
                );
                const requestedEventId = live.find(
                    (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.requested",
                )?.eventId;
                expect(requestedEventId).toBeDefined();
                const liveUserMessages = live.filter(
                    (event) => event.type === "acp" && event.payload.sessionUpdate === "user_message_chunk",
                );
                expect(liveUserMessages.map((event) => event.payload)).toEqual(
                    userMessages.map((event) => event.payload),
                );
                const requestedIndex = live.findIndex((event) => event.eventId === requestedEventId);
                const firstChunkIndex = live.findIndex((event) => event.eventId === liveUserMessages[0]?.eventId);
                expect(firstChunkIndex).toBeGreaterThan(requestedIndex);
                expect(live.slice(firstChunkIndex, firstChunkIndex + liveUserMessages.length)).toEqual(
                    liveUserMessages,
                );
                expect(userMessages).toHaveLength(scenario === "text-only" ? 1 : 2);
                expect(userMessages[0]).toMatchObject({
                    eventId: liveUserMessages[0]?.eventId,
                    payload: {
                        content: { text: command.prompt, type: "text" },
                        messageId: "user-1",
                        sessionUpdate: "user_message_chunk",
                    },
                });
                if (scenario === "with attachment") {
                    expect(userMessages[1]).toMatchObject({
                        payload: {
                            content: {
                                mimeType: "text/plain",
                                type: "resource_link",
                                uri: expect.stringMatching(/^file:\/\/\/.*\.txt$/u),
                            },
                            messageId: "user-1",
                            sessionUpdate: "user_message_chunk",
                        },
                    });
                    expect(userMessages[1]?.eventId).not.toBe(userMessages[0]?.eventId);
                }
                expect((await history(fixture, command)).events).toEqual(page.events);
                expect(page.throughPosition).toBe(live.at(-1)?.position);
                expect(await activeTurn(fixture, command)).toBeNull();
            } finally {
                await fixture.close();
            }
        },
    );

    // @no-uc: Performance; the first answer must reach the Relay while the ordinary batching clock is paused.
    it("delivers the first answer of each Turn before the batching clock advances", async () => {
        const fixture = await startControlledDaemon();
        try {
            let previousPosition = 0;
            for (const commandId of ["first-unbuffered-answer", "second-unbuffered-answer"]) {
                const command = { ...prompt(fixture, commandId), commandId };
                await sendText(fixture.socket, encodeSessionPromptCommand(command));
                let firstAnswer: SessionLiveEvent | undefined;
                for (;;) {
                    const frame = await fixture.frames.next(AbortSignal.timeout(5_000));
                    if (decodeMessageKind(frame) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    const events = decodeSessionEventEnvelope(frame).events;
                    firstAnswer = events.find(
                        (event) =>
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text" &&
                            event.payload.content.text.length > 0,
                    );
                    if (firstAnswer !== undefined) {
                        const positions = events.map((event) => Number(event.position));
                        expect(positions).toEqual([...positions].sort((a, b) => a - b));
                        break;
                    }
                }
                expect(sameNativeSession(firstAnswer.target, command.target)).toBe(true);
                expect(Number(firstAnswer.position)).toBeGreaterThan(previousPosition);
                previousPosition = Number(firstAnswer.position);
                for (;;) {
                    const event = await nextLive(fixture);
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        break;
                    }
                }
            }
        } finally {
            await fixture.close();
        }
    }, 15_000);

    it("Given a Session emits events before a daemon restart, When Sessions emit after restart, Then event IDs restart per generation and positions stay monotonic per Session", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-event-id-"));
        let firstGenerationId = "";
        let firstPosition = "";
        let lastPosition = 0;
        const first = await startControlledDaemon({ stateDirectory });
        try {
            const command = { ...prompt(first, "first allocation"), commandId: "first-allocation" };
            await sendText(first.socket, encodeSessionPromptCommand(command));
            let firstEvent = true;
            for (;;) {
                const event = await nextLive(first);
                expect(Number(event.position)).toBeGreaterThan(lastPosition);
                lastPosition = Number(event.position);
                if (firstEvent) {
                    firstEvent = false;
                    firstGenerationId = event.sessionGenerationId;
                    firstPosition = event.position;
                    expect(event.eventId.endsWith("-0000000000000001")).toBe(true);
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    break;
                }
            }
        } finally {
            await first.close();
        }

        const restarted = await startControlledDaemon({ stateDirectory });
        try {
            const command = { ...prompt(restarted, "second allocation"), commandId: "second-allocation" };
            await sendText(restarted.socket, encodeSessionPromptCommand(command));
            const retainedOutcome = await nextLive(restarted);
            expect(
                retainedOutcome.type === "lifecycle-metadata" && retainedOutcome.payload.kind === "prompt.completed",
            ).toBe(true);
            let event = await nextLive(restarted);
            expect(event.sessionGenerationId).not.toBe(firstGenerationId);
            expect(event.eventId.startsWith(`event-${event.sessionGenerationId}-`)).toBe(true);
            expect(Number(event.position)).toBeGreaterThan(lastPosition);
            while (event.type !== "lifecycle-metadata" || event.payload.kind !== "prompt.completed") {
                const previousPosition = Number(event.position);
                event = await nextLive(restarted);
                expect(Number(event.position)).toBeGreaterThan(previousPosition);
            }

            await sendText(
                restarted.socket,
                encodeSessionCreateCommand({
                    kind: "session.create",
                    requestId: "other-create",
                    operationId: "other-creation",
                    harness: restarted.agent.harness,
                    directory: ".",
                    configurations: [],
                }),
            );
            let created = await restarted.frames.next();
            while (decodeMessageKind(created) !== "session.ready") {
                if (decodeMessageKind(created) === "session.operation.failed") {
                    throw new Error(created);
                }
                created = await restarted.frames.next();
            }
            const otherSessionCommand = {
                ...prompt(restarted, "separate Session allocation"),
                commandId: "separate-session-allocation",
                requestId: "separate-session-allocation",
                target: decodeSessionReadyEvent(created).target,
            };
            await sendText(restarted.socket, encodeSessionPromptCommand(otherSessionCommand));
            const otherSessionEvent = await nextLive(restarted);
            expect(otherSessionEvent.eventId.endsWith("-0000000000000001")).toBe(true);
            expect(otherSessionEvent.position).toBe(firstPosition);
        } finally {
            await restarted.close();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given reasoning exceeds a history page, When a client loads live history, Then it receives the reasoning text with pagination", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "stream paged reasoning");
            await sendText(fixture.socket, encodeSessionPromptCommand(command));
            for (;;) {
                const event = await nextLive(fixture);
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    break;
                }
            }
            const page = await history(fixture, command, { eventLimit: 200 });
            const reasoning = page.events.filter(
                (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk",
            );

            expect(page.throughPosition).toBeDefined();
            expect(page.events).toHaveLength(200);
            expect(reasoning.length).toBeGreaterThan(0);
            for (const event of reasoning) {
                if (event.type !== "acp" || event.payload.sessionUpdate !== "agent_thought_chunk") {
                    throw new Error("Expected reasoning");
                }
                expect(event.mortyMetadata?.omitted).not.toBe(true);
                expect(event.payload.content).toMatchObject({ type: "text", text: expect.stringContaining("chunk-") });
            }
        } finally {
            await fixture.close();
        }
    });
    it("Given text surrounds a tool call, When a viewer reopens live history, Then the streamed and recovered events preserve the same order", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "interleave progress and hold");
            await sendText(fixture.socket, encodeSessionPromptCommand(command));
            const live: SessionLiveEvent[] = [];
            const order: string[] = [];
            let accumulated = "";
            for (;;) {
                const event = await nextLive(fixture);
                live.push(event);
                if (event.type !== "acp") {
                    continue;
                }
                const update = event.payload;
                if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                    if (update.content.text.includes("Checking the workspace")) {
                        order.push("first-message");
                    }
                    accumulated += update.content.text;
                    if (accumulated.includes("Controlled ACP turn 1: interleave progress and hold")) {
                        order.push("final-message");
                        break;
                    }
                }
                if (update.sessionUpdate === "tool_call_update" && update.status === "completed") {
                    order.push("tool");
                }
            }
            expect(order).toEqual(["first-message", "tool", "final-message"]);
            const page = await history(fixture, command);
            const liveEventIds = new Set(live.map((event) => event.eventId));
            expect(page.events.every((event) => liveEventIds.has(event.eventId))).toBe(true);
            expect(page.events.length).toBeLessThan(live.length);
            expect(
                page.events.filter(
                    (event) =>
                        event.type === "acp" &&
                        (event.payload.sessionUpdate === "tool_call" ||
                            event.payload.sessionUpdate === "tool_call_update"),
                ),
            ).toHaveLength(1);
            const active = await activeTurn(fixture, command);
            expect(active?.commandId).toBe(command.commandId);
            await cancel(fixture, command);
        } finally {
            await fixture.close();
        }
    });

    it("Given cumulative tool updates, When a viewer reopens history, Then prior cursor positions are retained without duplicate output", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "stream cumulative tool output");
            await sendText(fixture.socket, encodeSessionPromptCommand(command));
            for (;;) {
                const event = await nextLive(fixture);
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    break;
                }
            }

            const page = await history(fixture, command);
            const updates = page.events.flatMap((event) =>
                event.type === "acp" &&
                (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update")
                    ? [event]
                    : [],
            );
            expect(updates.map((event) => event.payload)).toEqual([
                expect.objectContaining({
                    content: [{ content: { text: "rendered snapshot", type: "text" }, type: "content" }],
                    rawOutput: { output: "final snapshot" },
                    sessionUpdate: "tool_call",
                    status: "completed",
                    toolCallId: "tool-1",
                }),
            ]);
        } finally {
            await fixture.close();
        }
    });
    it("Given token-sized chunks, When the turn completes, Then every token arrives once and live event identities match recovery", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "stream token burst");
            await sendText(fixture.socket, encodeSessionPromptCommand(command));
            const live: SessionLiveEvent[] = [];
            let text = "";
            for (;;) {
                const event = await nextLive(fixture);
                live.push(event);
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    text += event.payload.content.text;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
                    break;
                }
            }
            expect(text).toBe(
                `Gathering contextControlled ACP turn 1: ${Array.from({ length: 64 }, (_, index) => `token-${index} `).join("")}`,
            );
            expect(fixture.timer.batchWindowMilliseconds).toContain(100);
            expect(fixture.liveBatchSizes.some((size) => size > 1)).toBe(true);
            const page = await history(fixture, command);
            expect(page.throughPosition).toBe(live.at(-1)?.position);
            const liveEventIds = new Set(live.map((event) => event.eventId));
            expect(page.events.every((event) => liveEventIds.has(event.eventId))).toBe(true);
            expect(page.events.length).toBeLessThan(live.length);
            expect(
                page.events
                    .flatMap((event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                            ? [event.payload.content.text]
                            : [],
                    )
                    .join(""),
            ).toBe(
                `Gathering contextControlled ACP turn 1: ${Array.from({ length: 64 }, (_, index) => `token-${index} `).join("")}`,
            );
        } finally {
            await fixture.close();
        }
    });
    it("Given a 300k character current turn, When a viewer opens history and then cancels, Then recovery contains the complete output and the active turn is released", async () => {
        const fixture = await startControlledDaemon();
        try {
            const command = prompt(fixture, "hold after large output");
            await sendText(fixture.socket, encodeSessionPromptCommand(command));
            let text = "";
            let lastPosition = "0";
            while (text.length < 300_000) {
                const event = await nextLive(fixture);
                lastPosition = event.position;
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    if (event.payload.content.text !== "Gathering context") {
                        text += event.payload.content.text;
                    }
                }
            }
            expect(text).toBe("x".repeat(300_000));
            expect(await activeTurn(fixture, command)).not.toBeNull();
            const page = await history(fixture, command);
            // The running Agent can emit metadata after its last text chunk.
            // The snapshot must cover every observed event, including that text.
            expect(BigInt(page.throughPosition)).toBeGreaterThanOrEqual(BigInt(lastPosition));
            expect(page.nextCursor).toBeNull();
            const recovered = page.events
                .flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                )
                .join("");
            expect(recovered).toBe(`Gathering context${text}`);
            await cancel(fixture, command);
            expect(await activeTurn(fixture, command)).toBeNull();
        } finally {
            await fixture.close();
        }
    });
});
