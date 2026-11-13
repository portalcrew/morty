import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConnection, agent, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    decodeSessionPreviewHistoryPageLoaded,
    decodeSessionReadyEvent,
    encodeSessionCreateCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPreviewHistoryPageLoad,
    encodeSessionPromptCommand,
    encodeWorkspaceListCommand,
    type NativeSessionTarget,
    SESSION_EVENT_BATCH_MAX_SIZE,
    SESSION_EVENT_KIND,
    type SessionLiveEvent,
    WORKSPACE_ENTRIES_KIND,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { type ControlledAcpPeer, ControlledEndpointConnection } from "@morty-build/runtime-test-support/fake-daemon";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { IdentifiedSessionNotification } from "../../src/engine/acp/connection/session-notification.ts";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import type { ScheduledTask, Timer } from "../../src/engine/util/timer.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../support/controlled-runtime-config.ts";
import { createEncryptedDaemonGateway, type EncryptedDaemonPeer } from "../support/encrypted-daemon-gateway.ts";

// Failure modes exercised through the production daemon and its real WebSocket transport:
// - a disconnect discards a batch whose delivery timer has not fired;
// - an Agent's final text and completion arrive while the Relay is disconnected;
// - a reconnect duplicates already sent text or reorders concurrent Sessions;
// - an offline burst violates frame limits or grows the pending output without a bound.
// The controlled ACP producer establishes transport recovery, not Agent compatibility.

class ManualTask implements ScheduledTask {
    #cancelled = false;
    readonly #callback: () => void;

    constructor(callback: () => void) {
        this.#callback = callback;
    }

    readonly cancel = (): void => {
        this.#cancelled = true;
    };

    readonly run = (): void => {
        if (!this.#cancelled) {
            this.#cancelled = true;
            this.#callback();
        }
    };
}

class ManualTimer implements Timer {
    readonly #tasks = new Map<number, ManualTask[]>();
    readonly #waiters = new Map<number, Array<(task: ManualTask) => void>>();

    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        const task = new ManualTask(callback);
        const waiter = this.#waiters.get(milliseconds)?.shift();
        if (waiter !== undefined) {
            waiter(task);
        } else {
            const tasks = this.#tasks.get(milliseconds) ?? [];
            tasks.push(task);
            this.#tasks.set(milliseconds, tasks);
        }
        return task;
    };

    readonly next = (milliseconds: number): Promise<ManualTask> => {
        const task = this.#tasks.get(milliseconds)?.shift();
        if (task !== undefined) {
            return Promise.resolve(task);
        }
        return new Promise((resolve) => {
            const waiters = this.#waiters.get(milliseconds) ?? [];
            waiters.push(resolve);
            this.#waiters.set(milliseconds, waiters);
        });
    };
}

interface ControlledTurn {
    readonly finish: () => void;
    readonly write: (text: string) => Promise<void>;
    readonly writeThought: (text: string) => Promise<void>;
}

class StreamingAgent {
    readonly #reasoning = new Map<string, string[]>();
    readonly #turns: ControlledTurn[] = [];
    readonly #waiters: Array<(turn: ControlledTurn) => void> = [];
    readonly #completions: Array<() => void> = [];

    readonly createEndpoint = (
        onSessionUpdate: (notification: IdentifiedSessionNotification) => Promise<void>,
    ): ControlledAcpPeer => {
        const terminated = Promise.withResolvers<{ readonly kind: "closed" }>();
        let connection: AgentConnection | null = null;
        const app = agent({ name: "controlled-offline-output" })
            .onConnect((connected) => {
                connection = connected;
            })
            .onRequest(methods.agent.initialize, () => ({
                protocolVersion: PROTOCOL_VERSION,
                agentCapabilities: { loadSession: true },
                agentInfo: { name: "controlled-offline-output", version: "1.0.0" },
                authMethods: [],
            }))
            .onRequest(methods.agent.session.new, () => ({ sessionId: crypto.randomUUID() }))
            .onRequest(methods.agent.session.load, async (context) => {
                for (const text of this.#reasoning.get(context.params.sessionId) ?? []) {
                    await onSessionUpdate({
                        sessionId: context.params.sessionId,
                        update: {
                            content: { type: "text", text },
                            messageId: context.params.sessionId,
                            sessionUpdate: "agent_thought_chunk",
                        },
                    });
                }
                return {};
            })
            .onRequest(methods.agent.session.prompt, async (context) => {
                const reasoning: string[] = [];
                this.#reasoning.set(context.params.sessionId, reasoning);
                const completion = Promise.withResolvers<void>();
                this.#completions.push(completion.resolve);
                const turn: ControlledTurn = {
                    finish: completion.resolve,
                    writeThought: async (text) => {
                        reasoning.push(text);
                        await onSessionUpdate({
                            sessionId: context.params.sessionId,
                            update: {
                                content: { type: "text", text },
                                messageId: context.params.sessionId,
                                sessionUpdate: "agent_thought_chunk",
                            },
                        });
                    },
                    write: async (text) =>
                        await onSessionUpdate({
                            sessionId: context.params.sessionId,
                            update: {
                                content: { type: "text", text },
                                messageId: context.params.sessionId,
                                sessionUpdate: "agent_message_chunk",
                            },
                        }),
                };
                const waiter = this.#waiters.shift();
                if (waiter === undefined) {
                    this.#turns.push(turn);
                } else {
                    waiter(turn);
                }
                await completion.promise;
                return { stopReason: "end_turn" };
            });
        return {
            app: () => app,
            terminated: terminated.promise,
            initialize: async (signal) => signal.throwIfAborted(),
            close: async () => {
                this.finishAll();
                connection?.close();
                terminated.resolve({ kind: "closed" });
            },
        };
    };

    readonly nextTurn = (): Promise<ControlledTurn> => {
        const turn = this.#turns.shift();
        return turn === undefined ? new Promise((resolve) => this.#waiters.push(resolve)) : Promise.resolve(turn);
    };

    readonly finishAll = (): void => {
        for (const finish of this.#completions) {
            finish();
        }
    };
}

class RelayPeer {
    readonly events: SessionLiveEvent[] = [];
    readonly batches: Array<{ readonly bytes: number; readonly count: number }> = [];
    readonly socket: WebSocket;
    readonly peer: EncryptedDaemonPeer;

    constructor(socket: WebSocket, peer: EncryptedDaemonPeer) {
        this.socket = socket;
        this.peer = peer;
        peer.observe((text) => {
            if (decodeMessageKind(text) === SESSION_EVENT_KIND) {
                const envelope = decodeSessionEventEnvelope(text);
                this.events.push(...envelope.events);
                this.batches.push({ bytes: Buffer.byteLength(text), count: envelope.events.length });
            }
        });
    }

    readonly send = (message: string): Promise<void> => this.peer.send(message);

    readonly next = (): Promise<string> => this.peer.next();

    readonly barrier = async (): Promise<void> => {
        await this.send(
            encodeWorkspaceListCommand({
                directory: ".",
                kind: "workspace.list",
                requestId: crypto.randomUUID(),
            }),
        );
        while (decodeMessageKind(await this.next()) !== WORKSPACE_ENTRIES_KIND) {
            // A response on the same ordered transport follows the reconnect flush.
        }
    };
}

function completions(events: readonly SessionLiveEvent[]): number {
    return events.filter((event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed")
        .length;
}

function answer(events: readonly SessionLiveEvent[], sessionTarget: NativeSessionTarget): string {
    return events
        .filter((event) => sameNativeSession(event.target, sessionTarget))
        .map((event) =>
            event.type === "acp" &&
            event.payload.sessionUpdate === "agent_message_chunk" &&
            event.payload.content.type === "text"
                ? event.payload.content.text
                : "",
        )
        .join("");
}

async function startRuntime() {
    const directory = await mkdtemp(join(tmpdir(), "morty-disconnected-output-"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const http = createServer((request, response) => {
        request.resume();
        response.writeHead(request.method === "PUT" ? 204 : 404).end();
    });
    const relay = new WebSocketServer({ server: http });
    const gateway = await createEncryptedDaemonGateway(directory, "disconnected-output", AbortSignal.timeout(120_000));
    const peers: RelayPeer[] = [];
    const waiters: Array<(peer: RelayPeer) => void> = [];
    relay.on("connection", (socket) => {
        const peer = new RelayPeer(socket, gateway.connect(socket));
        const waiter = waiters.shift();
        if (waiter === undefined) {
            peers.push(peer);
        } else {
            waiter(peer);
        }
    });
    await listen(http);
    const timer = new ManualTimer();
    const producer = new StreamingAgent();
    const config = createRuntimeConfig(
        {
            computerId: "disconnected-output",
            defaultWorkspace: workspace,
            relayUrl: new URL(`ws://127.0.0.1:${port(http).toString()}/daemon`),
            credentials: memoryComputerCredentials("r".repeat(43)),
        },
        [
            createControlledAgent(
                (options) =>
                    new ControlledEndpointConnection(producer.createEndpoint(options.client.onUpdate), options.client),
                "controlled",
                "Controlled Agent",
                process.execPath,
            ),
        ],
        new RuntimeLocalContext(directory, {}),
        async (agent) => agent,
    );
    let cancellation = new AbortController();
    let runtime = runRuntime(config, cancellation.signal, timer);
    const nextPeer = (): Promise<RelayPeer> => {
        const peer = peers.shift();
        return peer === undefined ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(peer);
    };
    const initial = await nextPeer();
    await initial.barrier();
    return {
        /** Flushes batched output to `peer` until it has received `count` prompt completions. */
        completions: async (peer: RelayPeer, count = 1): Promise<void> => {
            while (completions(peer.events) < count) {
                (await timer.next(100)).run();
                await peer.barrier();
            }
        },
        initial,
        producer,
        timer,
        nextPeer,
        prompt: async (
            peer: RelayPeer,
            label: string,
        ): Promise<ControlledTurn & { readonly sessionTarget: NativeSessionTarget }> => {
            await peer.send(
                encodeSessionCreateCommand({
                    kind: "session.create",
                    requestId: crypto.randomUUID(),
                    operationId: crypto.randomUUID(),
                    harness: "controlled",
                    directory: ".",
                    configurations: [],
                }),
            );
            let created = await peer.next();
            while (decodeMessageKind(created) !== "session.ready") {
                if (decodeMessageKind(created) === "session.operation.failed") {
                    throw new Error(created);
                }
                created = await peer.next();
            }
            const sessionTarget = decodeSessionReadyEvent(created).target;
            await peer.send(
                encodeSessionPromptCommand({
                    commandId: `command-${label}`,
                    requestId: `command-${label}`,
                    disposition: "append",
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "Finish the reply while the network is disconnected",
                    target: sessionTarget,
                }),
            );
            return { ...(await producer.nextTurn()), sessionTarget };
        },
        /** Stops the daemon and starts it again on the same state, returning its first Relay connection. */
        restart: async (): Promise<RelayPeer> => {
            cancellation.abort();
            await runtime;
            cancellation = new AbortController();
            runtime = runRuntime(config, cancellation.signal, timer);
            const peer = await nextPeer();
            await peer.barrier();
            return peer;
        },
        disconnect: async (peer: RelayPeer): Promise<ManualTask> => {
            const retry = timer.next(500);
            peer.socket.terminate();
            return await retry;
        },
        [Symbol.asyncDispose]: async () => {
            producer.finishAll();
            cancellation.abort();
            await runtime;
            await gateway.close();
            for (const socket of relay.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve) => relay.close(() => http.close(() => resolve())));
            await rm(directory, { force: true, recursive: true });
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T12:48:58.394Z"));
});

afterEach(() => vi.useRealTimers());

test.each([
    {
        label: "a single reasoning block above the wire string limit",
        chunks: ["r".repeat(1_000_001)],
        live: [`${"r".repeat(999_963)}... [omit 38 characters since 999963]`],
        expected: `${"r".repeat(24 * 1024 - 37)}... [omit 38 characters since 999963]`,
        meta: { truncated: true },
    },
    {
        label: "an oversized reasoning block with a surrogate pair beyond the wire bound",
        chunks: [`${"r".repeat(999_999)}\u{1f600}${"z".repeat(24 * 1024 - 4)}`],
        live: [`${"r".repeat(999_960)}... [omit 24613 characters since 999960]`],
        expected: `${"r".repeat(24 * 1024 - 40)}... [omit 24613 characters since 999960]`,
        meta: { truncated: true },
    },
    {
        label: "a multibyte reasoning block above the wire string limit",
        chunks: ["\u601d".repeat(1_000_001)],
        live: [`${"\u601d".repeat(999_963)}... [omit 38 characters since 999963]`],
        expected: `${"\u601d".repeat(8_179)}... [omit 38 characters since 999963]`,
        meta: { truncated: true },
    },
    {
        label: "a single reasoning block exactly at the wire string limit",
        chunks: ["r".repeat(1_000_000)],
        expected: "r".repeat(24 * 1024),
        meta: { truncated: true },
    },
    {
        label: "short chunks around oversized reasoning",
        chunks: ["short prefix ", `discarded${"r".repeat(24 * 1024)}`, " short suffix"],
        expected: `${"r".repeat(24 * 1024 - " short suffix".length)} short suffix`,
        meta: { truncated: true },
    },
    {
        label: "41 individually valid chunks whose merged text exceeds the wire limit",
        chunks: Array.from({ length: 41 }, () => "r".repeat(24 * 1024)),
        expected: "r".repeat(24 * 1024),
        meta: { truncated: true },
    },
    {
        label: "a single oversized UTF-8 chunk",
        chunks: [`discarded${"\u601d\u{1f600}r".repeat(12_000)} tail-0!!`],
        expected: `\u{1f600}r${"\u601d\u{1f600}r".repeat(3_070)} tail-0!!`,
        meta: { truncated: true },
    },
    {
        label: "merged UTF-8 reasoning across the byte boundary",
        chunks: ["\u601d\u{1f600}r".repeat(4_000), " tail-0!!"],
        expected: `\u{1f600}r${"\u601d\u{1f600}r".repeat(3_070)} tail-0!!`,
        meta: { truncated: true },
    },
    {
        label: "merged reasoning exactly at 24 KiB",
        chunks: ["x".repeat(12 * 1024), "y".repeat(12 * 1024)],
        expected: "x".repeat(12 * 1024) + "y".repeat(12 * 1024),
        meta: undefined,
    },
])(
    "Given $label, When a client loads history, Then projected reasoning retains only its last 24 KiB after wire bounding without changing answers",
    async ({ chunks, live, expected, meta }) => {
        await using runtime = await startRuntime();
        const turn = await runtime.prompt(runtime.initial, "reasoning-history");
        for (const chunk of chunks) {
            await turn.writeThought(chunk);
        }
        await turn.write("Complete answer");
        (await runtime.timer.next(100)).run();
        await runtime.initial.barrier();
        await runtime.initial.send(
            encodeSessionHistoryPageLoad({
                kind: "session.live-history.v2.page.load",
                target: turn.sessionTarget,
                requestId: "reasoning-history-page",
                cursor: null,
                eventLimit: 50,
            }),
        );
        for (;;) {
            const message = await runtime.initial.next();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind !== "session.live-history.v2.page.loaded") {
                continue;
            }
            const page = decodeSessionHistoryPageLoaded(message);
            const thoughts = page.events.events.events.flatMap((event) =>
                event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk" ? [event.payload] : [],
            );
            expect(thoughts).toEqual([
                {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: expect.any(String),
                    content: { type: "text", text: expected },
                    ...(meta === undefined ? {} : { meta }),
                },
            ]);
            expect(Buffer.byteLength(expected, "utf8")).toBeLessThanOrEqual(24 * 1024);
            expect(expected).not.toContain("\ufffd");
            expect(page.events.events.events).toContainEqual(
                expect.objectContaining({
                    type: "acp",
                    payload: expect.objectContaining({
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "Complete answer" },
                    }),
                }),
            );
            const liveThoughts = runtime.initial.events.flatMap((event) =>
                event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk" ? [event.payload] : [],
            );
            expect(
                liveThoughts.map((thought) => (thought.content.type === "text" ? thought.content.text : "")).join(""),
            ).toBe((live ?? chunks).join(""));
            for (const thought of liveThoughts) {
                expect(thought.meta).toBeUndefined();
                if (thought.content.type !== "text") {
                    throw new Error("Expected text reasoning");
                }
                expect(thought.content.text.length).toBeLessThanOrEqual(1_000_000);
                expect(thought.content.text).not.toContain("\ufffd");
                expect(thought.content.text.isWellFormed()).toBe(true);
            }
            break;
        }
        turn.finish();
        await runtime.completions(runtime.initial);
        const nativeThought = runtime.initial.events.find(
            (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk",
        );
        if (
            nativeThought?.type !== "acp" ||
            nativeThought.payload.sessionUpdate !== "agent_thought_chunk" ||
            typeof nativeThought.payload.messageId !== "string"
        ) {
            throw new Error("Expected the native Session identifier from the controlled Agent");
        }
        await runtime.initial.send(
            encodeSessionPreviewHistoryPageLoad({
                directory: ".",
                kind: "session.preview-history.page.load",
                target: { harness: "controlled", sessionId: nativeThought.payload.messageId },
                requestId: "reasoning-native-preview",
                cursor: null,
                eventLimit: 50,
            }),
        );
        for (;;) {
            const message = await runtime.initial.next();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind !== "session.preview-history.page.loaded") {
                continue;
            }
            const page = decodeSessionPreviewHistoryPageLoaded(message);
            const thoughts = page.events.events.events.flatMap((event) =>
                event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk" ? [event.payload] : [],
            );
            expect(thoughts).toEqual([
                {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: expect.any(String),
                    content: { type: "text", text: expected },
                    ...(meta === undefined ? {} : { meta }),
                },
            ]);
            break;
        }
    },
);

test("Given oversized reasoning chunks, When the daemon streams them to the Relay, Then live reasoning and answers remain complete without history truncation metadata", async () => {
    await using runtime = await startRuntime();
    const turn = await runtime.prompt(runtime.initial, "reasoning-tail");
    const oversized = `discarded prefix${"\u601d\u{1f600}r".repeat(12_000)} tail-0!!`;
    await turn.writeThought("short thought");
    await turn.writeThought(oversized);
    await turn.writeThought("x".repeat(24 * 1024));
    await turn.writeThought(`prefix${"y".repeat(24 * 1024)}`);
    await turn.write(oversized);
    turn.finish();
    await runtime.completions(runtime.initial);
    const thoughts = runtime.initial.events.flatMap((event) =>
        event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk" ? [event.payload] : [],
    );
    expect(thoughts.map((thought) => ({ content: thought.content, meta: thought.meta }))).toEqual([
        { content: { type: "text", text: "short thought" }, meta: undefined },
        {
            content: { type: "text", text: oversized },
            meta: undefined,
        },
        { content: { type: "text", text: "x".repeat(24 * 1024) }, meta: undefined },
        { content: { type: "text", text: `prefix${"y".repeat(24 * 1024)}` }, meta: undefined },
    ]);
    expect(answer(runtime.initial.events, turn.sessionTarget)).toBe(oversized);
});

test.each([true, false])(
    "Given a reply prefix was flushed=%s, When the Agent finishes while disconnected, Then reconnection delivers the complete reply and completion exactly once",
    async (flushed) => {
        await using runtime = await startRuntime();
        const turn = await runtime.prompt(runtime.initial, "tail-session");
        const pending = await runtime.timer.next(100);
        if (flushed) {
            await turn.write("Reply prefix; ");
            pending.run();
            while (answer(runtime.initial.events, turn.sessionTarget) !== "Reply prefix; ") {
                await runtime.initial.next();
            }
        }
        const retry = await runtime.disconnect(runtime.initial);
        // A cancelled batching task must not discard events retained for reconnection.
        pending.run();
        if (!flushed) {
            await turn.write("Reply prefix; ");
        }
        await turn.write("the final 161 characters remain available.");
        turn.finish();
        const reconnect = runtime.nextPeer();
        retry.run();
        const resumed = await reconnect;
        await resumed.barrier();
        await runtime.completions(resumed);
        const events = [...runtime.initial.events, ...resumed.events];
        expect(answer(events, turn.sessionTarget)).toBe("Reply prefix; the final 161 characters remain available.");
        expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
        expect(
            events.filter((event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed"),
        ).toMatchObject([
            {
                payload: {
                    commandId: "command-tail-session",
                    completion: { kind: "ended", stopReason: "end_turn" },
                    kind: "prompt.completed",
                },
            },
        ]);
    },
);

test("Given a daemon restarted with a retained outcome, When the Relay reconnects, Then the outcome is delivered once", async () => {
    await using runtime = await startRuntime();
    const turn = await runtime.prompt(runtime.initial, "restarted-session");
    await turn.write("Finished before the restart.");
    turn.finish();
    await runtime.completions(runtime.initial);

    const connections = [await runtime.restart()];
    // Each reconnection first hands over what the previous connection left unsent.
    for (const _ of [1, 2]) {
        const retry = await runtime.disconnect(connections.at(-1) ?? runtime.initial);
        const reconnect = runtime.nextPeer();
        retry.run();
        const resumed = await reconnect;
        await resumed.barrier();
        connections.push(resumed);
    }

    const outcomes = connections
        .flatMap((connection) => connection.events)
        .filter((event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed");
    expect(outcomes).toMatchObject([{ payload: { commandId: "command-restarted-session", kind: "prompt.completed" } }]);
});

test("Given concurrent Sessions produce an offline burst, When the Computer reconnects, Then every event reaches the Relay in order within protocol frame limits", async () => {
    await using runtime = await startRuntime();
    const first = await runtime.prompt(runtime.initial, "burst-first");
    const second = await runtime.prompt(runtime.initial, "burst-second");
    (await runtime.timer.next(100)).run();
    await runtime.initial.barrier();
    const retry = await runtime.disconnect(runtime.initial);
    const expected: string[] = [];
    for (let index = 0; index < SESSION_EVENT_BATCH_MAX_SIZE + 2; index += 1) {
        const text = `${index.toString()};`;
        expected.push(text);
        await first.write(text);
    }
    const large = "\u00e9".repeat(250_000);
    for (let index = 0; index < 3; index += 1) {
        await second.write(large);
    }
    first.finish();
    second.finish();
    const reconnect = runtime.nextPeer();
    retry.run();
    const resumed = await reconnect;
    await resumed.barrier();
    await runtime.completions(resumed, 2);
    expect(answer(resumed.events, first.sessionTarget)).toBe(expected.join(""));
    expect(answer(resumed.events, second.sessionTarget)).toBe(large.repeat(3));
    expect(resumed.batches.length).toBeGreaterThan(1);
    expect(resumed.batches.every((batch) => batch.count <= SESSION_EVENT_BATCH_MAX_SIZE)).toBe(true);
    expect(resumed.batches.every((batch) => batch.bytes <= 1024 * 1024)).toBe(true);
    for (const sessionTarget of [first.sessionTarget, second.sessionTarget]) {
        const positions = resumed.events
            .filter((event) => sameNativeSession(event.target, sessionTarget))
            .map((event) => Number(event.position));
        expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
    expect(new Set(resumed.events.map((event) => event.eventId)).size).toBe(resumed.events.length);
    expect(
        resumed.events.filter(
            (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
        ),
    ).toHaveLength(2);
});

test("Given an outage exhausts the bounded output buffer, When the Relay reconnects, Then pending output stays bounded and the Agent can continue streaming", async () => {
    await using runtime = await startRuntime();
    const turn = await runtime.prompt(runtime.initial, "bounded-session");
    (await runtime.timer.next(100)).run();
    await runtime.initial.barrier();
    const retry = await runtime.disconnect(runtime.initial);
    const chunk = "x".repeat(512 * 1024);
    for (let index = 0; index < 70; index += 1) {
        await turn.write(chunk);
    }
    const reconnect = runtime.nextPeer();
    retry.run();
    const resumed = await reconnect;
    await resumed.barrier();
    // A workspace reply can interleave with asynchronous event encryption. An
    // Agent marker on the same ordered event stream proves the retained tail drained.
    const reconnected = "reconnected-output-boundary";
    await turn.write(reconnected);
    (await runtime.timer.next(100)).run();
    while (!answer(resumed.events, turn.sessionTarget).endsWith(reconnected)) {
        await resumed.next();
    }
    const offlineAnswer = answer(resumed.events, turn.sessionTarget);
    expect(offlineAnswer.length).toBeGreaterThan(0);
    expect(resumed.batches.reduce((bytes, batch) => bytes + batch.bytes, 0)).toBeLessThanOrEqual(32 * 1024 * 1024);
    await turn.write("streaming continues after the outage");
    turn.finish();
    await runtime.completions(resumed);
    expect(answer(resumed.events, turn.sessionTarget)).toBe(`${offlineAnswer}streaming continues after the outage`);
    expect(
        resumed.events.filter(
            (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
        ),
    ).toMatchObject([{ payload: { kind: "prompt.completed", completion: { kind: "ended", stopReason: "end_turn" } } }]);
});
