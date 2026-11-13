import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    encodeNativeSessionCancel,
    encodeNativeSessionCommand,
    encodeSessionCreateCommand,
    encodeSessionListCommand,
    encodeSessionPromptCommand,
    NATIVE_SESSION_REQUEST_KIND,
    type NativeSessionTarget,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { type RuntimeConfig, RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { fakeAgentHarness } from "../support/agent-harness.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createControlledRuntimeConfig } from "../support/controlled-runtime-config.ts";
import { createEncryptedDaemonFrames } from "../support/encrypted-daemon-frames.ts";

function decodeNativeReply(encoded: string) {
    return decodeMessageKind(encoded) === "native.session.result"
        ? decodeNativeSessionResult(encoded)
        : decodeSessionOperationFailedEvent(encoded);
}

// @no-uc: Technical regression; a failed shared reader must not block the next native-browser request.
test("Given a shared native reader crashes while listing, When a fresh conversation and the original conversation browse again, Then both see saved history without restarting", async ({
    signal,
}) => {
    const peer = await runtimePeer(signal);
    const list = async (requestId: string) => {
        peer.send(
            encodeNativeSessionCommand({
                ...peer.base(),
                kind: NATIVE_SESSION_REQUEST_KIND,
                requestId,
                action: "list",
                cursor: null,
            }),
        );
        return decodeNativeReply(await peer.next(requestId, ["native.session.result", "session.operation.failed"]));
    };
    try {
        const seed = await peer.create();
        await peer.prompt(seed, "seed-history");
        const original = await list("list-before-crash");
        if (
            original.kind !== "native.session.result" ||
            original.action !== "list" ||
            original.entries[0] === undefined
        ) {
            throw new Error("Expected the seeded native conversation");
        }
        await peer.crashNextNativeList();
        expect(await list("list-that-crashes")).toMatchObject({
            kind: "session.operation.failed",
            code: "session_operation_failed",
        });
        for (const sessionId of ["new-browser", "first-browser"]) {
            const result = await list(`retry-after-crash-${sessionId}`);
            expect(result).toMatchObject({
                kind: "native.session.result",
                action: "list",
                entries: [
                    expect.objectContaining({
                        sessionId: original.entries[0].sessionId,
                        title: original.entries[0].title,
                    }),
                ],
            });
        }
    } finally {
        await peer.close();
    }
});

// @no-uc: Technical regression; concurrent native openings retain independent harness namespaces.
test.for(["import", "fork"] as const)(
    "Given separate Agents, When native %s commands run concurrently, Then both harness-owned destinations remain usable",
    async (action, { signal }) => {
        const peer = await runtimePeer(signal);
        try {
            const seed = await peer.create();
            await peer.prompt(seed, "seed-history");
            await peer.restart("competing-computer");
            const candidates: { harness: string; sessionId: string }[] = [];
            for (const harness of ["codex", "other-codex"]) {
                const requestId = `list-${harness}`;
                peer.send(
                    encodeNativeSessionCommand({
                        ...peer.base(harness),
                        kind: NATIVE_SESSION_REQUEST_KIND,
                        requestId,
                        action: "list",
                        cursor: null,
                    }),
                );
                const result = decodeNativeSessionResult(await peer.next(requestId, ["native.session.result"]));
                if (result.action !== "list" || result.entries[0] === undefined) {
                    throw new Error("Expected native history for each Agent");
                }
                candidates.push({ harness, sessionId: result.entries[0].sessionId });
            }
            const outcomes = await Promise.all(
                candidates.map(async ({ harness, sessionId }) => {
                    const requestId = `open-${harness}`;
                    peer.send(
                        encodeNativeSessionCommand({
                            ...peer.base(harness),
                            kind: NATIVE_SESSION_REQUEST_KIND,
                            requestId,
                            action,
                            sessionId,
                        }),
                    );
                    const frame = await peer.next(requestId, ["native.session.result", "session.operation.failed"]);
                    return { harness, result: decodeNativeReply(frame) };
                }),
            );
            expect(outcomes.filter(({ result }) => result.kind === "native.session.result")).toHaveLength(2);
            for (const { harness, result } of outcomes) {
                if (result.kind !== "native.session.result" || result.action !== action) {
                    throw new Error("Expected native open result");
                }
                expect(result.target.harness).toBe(harness);
                await peer.prompt(result.target, `owner-continues-${harness}`);
            }
        } finally {
            await peer.close();
        }
    },
);

test.for(["complete", "cancel"] as const)(
    "Given two browsers reading the same Agent, When their native requests overlap and the second is set to %s, Then each receives its own result without rejecting the concurrent reader",
    async (outcome, { signal }) => {
        const entered = Promise.withResolvers<void>();
        const barrier = new EventEmitter();
        let holdNext = false;
        const peer = await runtimePeer(signal, async (agent, resolveSignal) => {
            if (holdNext) {
                holdNext = false;
                const released = once(barrier, "continue", { signal: resolveSignal });
                entered.resolve();
                await released;
            }
            return agent;
        });
        const list = (requestId: string) => {
            peer.send(
                encodeNativeSessionCommand({
                    ...peer.base(),
                    kind: NATIVE_SESSION_REQUEST_KIND,
                    requestId,
                    action: "list",
                    cursor: null,
                }),
            );
            return peer.next(requestId, ["native.session.result", "session.operation.failed"]);
        };
        try {
            const seed = await peer.create();
            await peer.prompt(seed, "seed-history");
            holdNext = true;
            const first = list("first-list");
            await entered.promise;
            const second = list("second-list");
            if (outcome === "cancel") {
                peer.send(
                    encodeNativeSessionCancel({
                        kind: "native.session.cancel",
                        requestId: "second-list",
                    }),
                );
            }
            // The independent wire reply establishes that both requests reached the Computer before release.
            peer.send(encodeSessionListCommand({ kind: "session.list", requestId: "received", limit: 1 }));
            await peer.next("received", ["session.listed"]);
            barrier.emit("continue");
            const original = decodeNativeSessionResult(await first);
            if (original.action !== "list" || original.entries[0] === undefined) {
                throw new Error("Expected the first browser's native history");
            }
            expect(decodeNativeReply(await second)).toMatchObject(
                outcome === "cancel"
                    ? { kind: "session.operation.failed", code: "native_session_cancelled", requestId: "second-list" }
                    : {
                          kind: "native.session.result",
                          action: "list",
                          requestId: "second-list",
                          entries: [{ sessionId: original.entries[0].sessionId }],
                      },
            );
            expect(decodeNativeSessionResult(await list("fresh-list"))).toMatchObject({
                action: "list",
                entries: [{ sessionId: original.entries[0].sessionId }],
            });
        } finally {
            barrier.emit("continue");
            await peer.close();
        }
    },
);

async function runtimePeer(signal: AbortSignal, resolveAgent?: RuntimeConfig["resolveAgent"]) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-session-environment-"));
    const workspace = join(directory, "workspace");
    const harnessState = join(directory, "harness");
    const launches = join(directory, "launches.jsonl");
    const nativeRequests = join(directory, "native-requests.jsonl");
    const launcher = join(directory, "agent.mjs");
    const agentPeer = new URL("../sessions/fixtures/acp-peer.ts", import.meta.url).href;
    await Promise.all([mkdir(workspace), mkdir(harnessState), writeFile(launches, ""), writeFile(nativeRequests, "")]);
    await writeFile(
        launcher,
        `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const context = process.env.MORTY_TEST_SESSION_CONTEXT ?? null;
appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ context }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (typeof request.method === "string" && /^(?:session|_session)\\//.test(request.method) && request.method !== "session/list") {
        appendFileSync(${JSON.stringify(nativeRequests)}, JSON.stringify({ context, method: request.method }) + "\\n");
    }
});
await import(${JSON.stringify(agentPeer)});
`,
    );
    const external = fakeAgentHarness({ harness: "codex", label: "Controlled ACP" }, harnessState);
    const createAgent = (harness: string) =>
        createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    { harness, adapterPath: process.execPath, arguments: [launcher], environment: options.environment },
                    options,
                ),
            harness,
            external.label,
            process.execPath,
            external.environment,
            external.agentVersion,
            external.capabilities,
        );
    const agent = createAgent("codex");
    const otherAgent = createAgent("other-codex");
    const relay = createServer((_request, response) => response.writeHead(204).end());
    const server = new WebSocketServer({ server: relay });
    const frames: string[] = [];
    const listeners = new Set<(frame: string) => void>();
    let socket: WebSocket | undefined;
    let encryption = await createEncryptedDaemonFrames(join(directory, "computer"), "environment", signal);
    const subscriptions = new Map<string, NativeSessionTarget>();
    const failure = Promise.withResolvers<never>();
    void failure.promise.catch(() => undefined);
    let outgoing: Promise<void> = Promise.resolve();
    let incoming: Promise<void> = Promise.resolve();
    server.on("connection", (connected) => {
        socket = connected;
        connected.on("message", (value) => {
            const frame = value.toString();
            if (frame === COMPUTER_HEARTBEAT_MESSAGE) {
                connected.send(COMPUTER_HEARTBEAT_ACK_MESSAGE);
            } else {
                const current = encryption;
                incoming = incoming
                    .then(async () => {
                        const decoded = await current.decode(frame);
                        if (typeof decoded !== "string") {
                            throw new Error("Expected a text daemon response");
                        }
                        frames.push(decoded);
                        for (const listener of listeners) {
                            listener(decoded);
                        }
                    })
                    .catch((error: unknown) => failure.reject(error));
            }
        });
        connected.send(JSON.stringify({ kind: "computer.liveness.ready" }));
    });
    const listening = once(relay, "listening", { signal });
    relay.listen(0, "127.0.0.1");
    await listening;
    const address = relay.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected the relay port");
    }
    const config = createControlledRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "environment",
            defaultWorkspace: workspace,
            relayUrl: new URL(`ws://127.0.0.1:${address.port}/morty/api/v1/computers/connect`),
        },
        [agent, otherAgent],
        new RuntimeLocalContext(join(directory, "computer"), process.env),
        resolveAgent,
    );
    let cancellation = new AbortController();
    const connected = once(server, "connection", { signal });
    let execution = runRuntime(config, cancellation.signal);
    await connected;
    const abort = () => cancellation.abort();
    signal.addEventListener("abort", abort, { once: true });
    const next = async (requestId: string, kinds: readonly string[]): Promise<string> => {
        await outgoing;
        const matches = (frame: string): boolean => {
            const value: unknown = JSON.parse(frame);
            if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string") {
                return false;
            }
            const addressed =
                ("requestId" in value && value.requestId === requestId) ||
                ("commandId" in value && value.commandId === requestId) ||
                (kinds.includes("prompt.completed") && frame.includes(JSON.stringify(requestId)));
            if (!addressed) {
                return false;
            }
            if (value.kind.endsWith(".failed") && !kinds.includes(value.kind)) {
                throw new Error(frame);
            }
            return (
                kinds.includes(value.kind) ||
                (kinds.includes("prompt.completed") && frame.includes(JSON.stringify("prompt.completed")))
            );
        };
        signal.throwIfAborted();
        const existing = frames.find(matches);
        if (existing !== undefined) {
            return existing;
        }
        return await Promise.race([
            failure.promise,
            new Promise<string>((resolve, reject) => {
                const cleanup = () => {
                    listeners.delete(receive);
                    signal.removeEventListener("abort", cancelled);
                };
                const cancelled = () => {
                    cleanup();
                    reject(signal.reason);
                };
                const receive = (frame: string) => {
                    try {
                        if (matches(frame)) {
                            cleanup();
                            resolve(frame);
                        }
                    } catch (error) {
                        cleanup();
                        reject(error);
                    }
                };
                listeners.add(receive);
                signal.addEventListener("abort", cancelled, { once: true });
            }),
        ]);
    };
    const send = (frame: string) => {
        if (socket === undefined) {
            throw new Error("The Computer has not connected");
        }
        const connection = socket;
        const current = encryption;
        outgoing = outgoing.then(async () => connection.send(await current.encode(frame)));
        void outgoing.catch((error: unknown) => failure.reject(error));
    };
    const subscribe = async (target: NativeSessionTarget): Promise<void> => {
        subscriptions.set(JSON.stringify([target.harness, target.sessionId]), target);
        send(JSON.stringify({ kind: "session.events.subscribe", subscriptionId: crypto.randomUUID(), target }));
        await outgoing;
    };
    const binding = (harness = "codex") => ({
        harness,
        directory: ".",
    });
    const base = (harness = "codex") => ({ ...binding(harness) });
    const readContexts = async (path: string) =>
        (await readFile(path, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
                const value: unknown = JSON.parse(line);
                if (
                    typeof value !== "object" ||
                    value === null ||
                    !("context" in value) ||
                    (value.context !== null && typeof value.context !== "string")
                ) {
                    throw new Error("Invalid child context report");
                }
                return { context: value.context };
            });
    return {
        agent,
        base,
        next,
        send,
        create: async () => {
            const requestId = crypto.randomUUID();
            send(
                encodeSessionCreateCommand({
                    ...binding(),
                    kind: "session.create",
                    requestId,
                    operationId: crypto.randomUUID(),
                    configurations: [],
                }),
            );
            const target = decodeSessionReadyEvent(await next(requestId, ["session.ready"])).target;
            await subscribe(target);
            return target;
        },
        launches: () => readContexts(launches),
        crashNextNativeList: () => writeFile(join(harnessState, "crash-next-list"), ""),
        nativeRequests: () => readContexts(nativeRequests),
        prompt: async (target: NativeSessionTarget, commandId: string) => {
            await subscribe(target);
            send(
                encodeSessionPromptCommand({
                    target,
                    kind: "session.prompt",
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    prompt: commandId,
                    attachments: [],
                }),
            );
            await next(commandId, ["prompt.completed"]);
        },
        restart: async (stateName: string) => {
            await outgoing;
            cancellation.abort();
            await execution;
            await incoming;
            encryption.close();
            encryption = await createEncryptedDaemonFrames(join(directory, stateName), "environment", signal);
            cancellation = new AbortController();
            const connected = once(server, "connection", { signal });
            execution = runRuntime(
                { ...config, localContext: new RuntimeLocalContext(join(directory, stateName), process.env) },
                cancellation.signal,
            );
            await connected;
            for (const target of subscriptions.values()) {
                await subscribe(target);
            }
        },
        close: async () => {
            signal.removeEventListener("abort", abort);
            cancellation.abort();
            await execution;
            await incoming;
            encryption.close();
            for (const connection of server.clients) {
                connection.terminate();
            }
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
            await new Promise<void>((resolve, reject) => relay.close((error) => (error ? reject(error) : resolve())));
            await rm(directory, { recursive: true, force: true });
            vi.useRealTimers();
        },
    };
}
