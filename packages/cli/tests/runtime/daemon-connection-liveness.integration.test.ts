import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_KIND,
    COMPUTER_HEARTBEAT_MESSAGE,
    COMPUTER_LIVENESS_READY_KIND,
    decodeComputerDiagnosticsResult,
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionReadyEvent,
    encodeComputerLivenessReadyEvent,
    encodeSessionCreateCommand,
    encodeSessionPromptCommand,
    encodeWorkspaceListCommand,
    MORTY_API_PREFIX,
    SESSION_EVENT_KIND,
    SESSION_PROMPT_KIND,
    type SessionLiveEvent,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "@morty-build/client/protocol";
import { listen, port as readPort, sendText as writeServerTextFrame } from "@morty-build/relay-test-support/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeConfig, RuntimeAgentDependencies, RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { ComputerRelayRevokedError } from "../../src/engine/runtime/relay/computer-revocation.ts";
import { SESSION_EVENT_BATCH_WINDOW_MILLISECONDS } from "../../src/engine/runtime/relay/session-event-publisher.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { type ScheduledTask, systemTimer, type Timer } from "../../src/engine/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createEncryptedDaemonFrames } from "../support/encrypted-daemon-frames.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("../sessions/fixtures/acp-peer.ts", import.meta.url));
type EncryptedFrames = Awaited<ReturnType<typeof createEncryptedDaemonFrames>>;

async function decodeClientFrame(
    frame: ClientWebSocketFrame,
    encryption: EncryptedFrames,
): Promise<ClientWebSocketFrame> {
    if (frame.opcode !== 1 || frame.text === COMPUTER_HEARTBEAT_MESSAGE) {
        return frame;
    }
    return new ClientWebSocketFrame(frame.opcode, await encryption.decode(frame.text));
}

function restoreEnvironmentVariable(name: string, previous: string | undefined): void {
    if (previous === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = previous;
}

class ClientWebSocketFrame {
    readonly opcode: number;
    readonly text: string;
    readonly bytes: Buffer;

    constructor(opcode: number, text: string, bytes = Buffer.from(text)) {
        this.opcode = opcode;
        this.text = text;
        this.bytes = bytes;
    }
}

class ControllableDaemonTask implements ScheduledTask {
    readonly #callback: () => void;
    #cancelled = false;

    constructor(callback: () => void) {
        this.#callback = callback;
    }

    readonly cancel = (): void => {
        this.#cancelled = true;
    };

    readonly run = (): void => {
        if (this.#cancelled) {
            return;
        }
        this.#cancelled = true;
        this.#callback();
    };
}

class ControllableTimer implements Timer {
    readonly #scheduled = new Map<number, ControllableDaemonTask[]>();
    readonly #waiters = new Map<number, Array<(task: ControllableDaemonTask) => void>>();

    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        const task = new ControllableDaemonTask(callback);
        const waiter = this.#waiters.get(milliseconds)?.shift();
        if (waiter !== undefined) {
            waiter(task);
            return task;
        }
        const scheduled = this.#scheduled.get(milliseconds) ?? [];
        scheduled.push(task);
        this.#scheduled.set(milliseconds, scheduled);
        return task;
    };

    readonly waitForTask = (milliseconds: number): Promise<ControllableDaemonTask> => {
        const scheduled = this.#scheduled.get(milliseconds);
        const task = scheduled?.shift();
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

function readClientFrame(socket: Duplex, encryption?: EncryptedFrames): Promise<ClientWebSocketFrame> {
    return new Promise<ClientWebSocketFrame>((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const fail = (error: Error): void => {
            cleanup();
            reject(error);
        };
        const cleanup = (): void => {
            socket.removeListener("close", handleClose);
            socket.removeListener("data", handleData);
            socket.removeListener("error", fail);
        };
        const handleClose = (): void => {
            fail(new Error("Daemon connection closed before sending a frame"));
        };
        const handleData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.byteLength < 6) {
                return;
            }
            const encodedLength = buffered.readUInt8(1) & 0x7f;
            if (encodedLength === 127) {
                fail(new Error("Test relay received an oversized client frame"));
                return;
            }
            const headerLength = encodedLength === 126 ? 4 : 2;
            if (buffered.byteLength < headerLength + 4) {
                return;
            }
            const payloadLength = encodedLength === 126 ? buffered.readUInt16BE(2) : encodedLength;
            const frameLength = headerLength + 4 + payloadLength;
            if (buffered.byteLength < frameLength) {
                return;
            }
            const mask = buffered.subarray(headerLength, headerLength + 4);
            const payload = Buffer.from(buffered.subarray(headerLength + 4, frameLength));
            for (let index = 0; index < payload.byteLength; index += 1) {
                payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
            }
            const opcode = buffered.readUInt8(0) & 0x0f;
            cleanup();
            resolve(new ClientWebSocketFrame(opcode, payload.toString("utf8"), payload));
        };
        socket.on("close", handleClose);
        socket.on("data", handleData);
        socket.on("error", fail);
    }).then(async (frame) => (encryption === undefined ? frame : await decodeClientFrame(frame, encryption)));
}

function observeClientFrames(socket: Duplex, observe: (frame: ClientWebSocketFrame) => void): () => void {
    let buffered = Buffer.alloc(0);
    const handleData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.byteLength >= 6) {
            const encodedLength = buffered.readUInt8(1) & 0x7f;
            if (encodedLength === 127) {
                throw new Error("Test relay received an oversized client frame");
            }
            const headerLength = encodedLength === 126 ? 4 : 2;
            if (buffered.byteLength < headerLength + 4) {
                return;
            }
            const payloadLength = encodedLength === 126 ? buffered.readUInt16BE(2) : encodedLength;
            const frameLength = headerLength + 4 + payloadLength;
            if (buffered.byteLength < frameLength) {
                return;
            }
            const mask = buffered.subarray(headerLength, headerLength + 4);
            const payload = Buffer.from(buffered.subarray(headerLength + 4, frameLength));
            for (let index = 0; index < payload.byteLength; index += 1) {
                payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
            }
            observe(new ClientWebSocketFrame(buffered.readUInt8(0) & 0x0f, payload.toString("utf8"), payload));
            buffered = buffered.subarray(frameLength);
        }
    };
    socket.on("data", handleData);
    return () => socket.removeListener("data", handleData);
}

class ClientFrameQueue {
    readonly #frames: ClientWebSocketFrame[] = [];
    readonly #waiters: Array<(frame: ClientWebSocketFrame) => void> = [];
    readonly close: () => void;
    readonly #socket: Duplex;
    readonly #encryption: EncryptedFrames;

    constructor(socket: Duplex, encryption: EncryptedFrames) {
        this.#socket = socket;
        this.#encryption = encryption;
        this.close = observeClientFrames(socket, (frame) => {
            const resolve = this.#waiters.shift();
            if (resolve === undefined) {
                this.#frames.push(frame);
            } else {
                resolve(frame);
            }
        });
    }

    readonly next = async (): Promise<ClientWebSocketFrame> => {
        const raw =
            this.#frames.shift() ?? (await new Promise<ClientWebSocketFrame>((resolve) => this.#waiters.push(resolve)));
        const frame = await decodeClientFrame(raw, this.#encryption);
        if (frame.opcode === 1 && decodeMessageKind(frame.text) === "session.ready") {
            writeServerTextFrame(
                this.#socket,
                await this.#encryption.encode(
                    JSON.stringify({
                        kind: "session.events.subscribe",
                        subscriptionId: crypto.randomUUID(),
                        target: decodeSessionReadyEvent(frame.text).target,
                    }),
                ),
            );
        }
        return frame;
    };
}

/** Reads daemon frames until one carries `kind`, skipping unrelated traffic. */
async function nextFrameOfKind(
    frames: ClientFrameQueue,
    kind: string,
    remaining: number = 16,
): Promise<ClientWebSocketFrame> {
    if (remaining === 0) {
        throw new Error(`Test relay did not receive a ${kind} frame`);
    }
    const frame = await frames.next();
    return decodeMessageKind(frame.text) === kind ? frame : await nextFrameOfKind(frames, kind, remaining - 1);
}

function writeServerCloseFrame(socket: Duplex, code: number, reason: string): void {
    const reasonPayload = Buffer.from(reason, "utf8");
    const payload = Buffer.allocUnsafe(reasonPayload.byteLength + 2);
    payload.writeUInt16BE(code, 0);
    reasonPayload.copy(payload, 2);
    socket.write(Buffer.concat([Buffer.from([0x88, payload.byteLength]), payload]));
}

function respondToClientClose(socket: Duplex): void {
    socket.on("data", (chunk: Buffer) => {
        if (chunk.byteLength > 0 && (chunk.readUInt8(0) & 0x0f) === 8) {
            socket.end(Buffer.from([0x88, 0]));
        }
    });
}

describe("daemon relay connection liveness", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("Given a liveness-capable relay stops acknowledging heartbeats, When the acknowledgement deadline expires, Then the daemon reconnects", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-heartbeat-"));
        const encryption = await createEncryptedDaemonFrames(
            stateDirectory,
            "heartbeat-channel",
            AbortSignal.timeout(120_000),
        );
        const sendCommand = async (socket: Duplex, message: string): Promise<void> =>
            writeServerTextFrame(socket, await encryption.encode(message));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MORTY_API_PREFIX}/v1/computers/heartbeat-channel/catalog`
            ) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const upgradeWaiters: Array<() => void> = [];
        const clientFrames: Array<Promise<ClientWebSocketFrame>> = [];
        const daemonSockets: Duplex[] = [];
        const waitForUpgrade = (): Promise<void> => new Promise((resolve) => upgradeWaiters.push(resolve));
        relay.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            daemonSockets.push(socket);
            clientFrames.push(readClientFrame(socket));
            respondToClientClose(socket);
            writeServerTextFrame(
                socket,
                JSON.stringify({
                    kind: COMPUTER_LIVENESS_READY_KIND,
                }),
            );
            upgradeWaiters.shift()?.();
        });
        await listen(relay);
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MORTY_CODEX_PATH"];
        const previousClaudePath = process.env["MORTY_CLAUDE_PATH"];
        const previousStateDirectory = process.env["MORTY_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MORTY_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MORTY_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MORTY_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createRuntimeConfig(
            {
                credentials: memoryComputerCredentials("r".repeat(43)),
                defaultWorkspace,
                computerId: "heartbeat-channel",
                relayUrl: new URL(
                    `ws://127.0.0.1:${readPort(relay)}${MORTY_API_PREFIX}/channels/heartbeat-channel/daemon`,
                ),
            },
            new RuntimeAgentDependencies([]),
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );

        vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
        vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            await firstConnection;
            const firstFrame = clientFrames[0];
            if (firstFrame === undefined) {
                throw new Error("Test relay did not observe the daemon connection");
            }
            const heartbeatFrame = await firstFrame;
            expect(heartbeatFrame.opcode).toBe(1);
            // The Relay's host answers only this exact text, without waking the Relay.
            expect(heartbeatFrame.text).toBe(COMPUTER_HEARTBEAT_MESSAGE);
            const firstSocket = daemonSockets[0];
            if (firstSocket === undefined) {
                throw new Error("Test relay did not retain the daemon connection");
            }
            const controlResponse = readClientFrame(firstSocket, encryption);
            writeServerTextFrame(firstSocket, COMPUTER_HEARTBEAT_ACK_MESSAGE);
            await sendCommand(
                firstSocket,
                encodeWorkspaceListCommand({
                    directory: ".",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: "acknowledgement-barrier",
                }),
            );
            expect(decodeMessageKind((await controlResponse).text)).toBe(WORKSPACE_ENTRIES_KIND);

            const unacknowledgedHeartbeat = readClientFrame(firstSocket);
            await vi.advanceTimersByTimeAsync(20_000);
            expect((await unacknowledgedHeartbeat).text).toBe(COMPUTER_HEARTBEAT_MESSAGE);

            const refreshedConnection = waitForUpgrade();
            await vi.advanceTimersByTimeAsync(10_000);
            await vi.advanceTimersByTimeAsync(500);
            await refreshedConnection;
            const refreshedFrame = clientFrames[1];
            if (refreshedFrame === undefined) {
                throw new Error("Test relay did not observe the refreshed connection");
            }
            expect((await refreshedFrame).opcode).toBe(1);
        } finally {
            cancellation.abort();
            await vi.runAllTimersAsync();
            await runtime;
            encryption.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                relay.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
            restoreEnvironmentVariable("MORTY_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MORTY_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MORTY_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an active Computer is revoked by the Relay, When the daemon receives the terminal close, Then it exits instead of reconnecting", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-computer-revoked-"));
        const encryption = await createEncryptedDaemonFrames(
            stateDirectory,
            "computer-revoked-channel",
            AbortSignal.timeout(120_000),
        );
        const sendCommand = async (socket: Duplex, message: string): Promise<void> =>
            writeServerTextFrame(socket, await encryption.encode(message));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MORTY_API_PREFIX}/v1/computers/computer-revoked-channel/catalog`
            ) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        let resolveUpgrade = (_socket: Duplex): void => undefined;
        const upgraded = new Promise<Duplex>((resolve) => {
            resolveUpgrade = resolve;
        });
        let upgradeCount = 0;
        relay.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            upgradeCount += 1;
            respondToClientClose(socket);
            resolveUpgrade(socket);
        });
        await listen(relay);
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MORTY_CODEX_PATH"];
        const previousClaudePath = process.env["MORTY_CLAUDE_PATH"];
        const previousStateDirectory = process.env["MORTY_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MORTY_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MORTY_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MORTY_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createRuntimeConfig(
            {
                credentials: memoryComputerCredentials("r".repeat(43)),
                defaultWorkspace,
                computerId: "computer-revoked-channel",
                relayUrl: new URL(
                    `ws://127.0.0.1:${readPort(relay)}${MORTY_API_PREFIX}/channels/computer-revoked-channel/daemon`,
                ),
            },
            new RuntimeAgentDependencies([]),
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );
        const online = Promise.withResolvers<void>();
        const statuses: string[] = [];
        const runtime = runRuntime(config, cancellation.signal, undefined, {
            onConnectionStatus: (status) => {
                statuses.push(status);
                if (status === "online") {
                    online.resolve();
                }
            },
        });

        try {
            const socket = await upgraded;
            const barrier = readClientFrame(socket, encryption);
            await sendCommand(
                socket,
                encodeWorkspaceListCommand({
                    directory: ".",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: "before-relay-ready",
                }),
            );
            expect(decodeMessageKind((await barrier).text)).toBe(WORKSPACE_ENTRIES_KIND);
            expect(statuses).not.toContain("online");
            const heartbeat = readClientFrame(socket);
            writeServerTextFrame(socket, encodeComputerLivenessReadyEvent({ kind: COMPUTER_LIVENESS_READY_KIND }));
            expect(decodeMessageKind((await heartbeat).text)).toBe(COMPUTER_HEARTBEAT_KIND);
            await online.promise;
            expect(statuses).toContain("online");
            writeServerCloseFrame(socket, 1008, "Computer revoked");

            await expect(runtime).rejects.toBeInstanceOf(ComputerRelayRevokedError);
            await expect(runtime).rejects.toMatchObject({
                code: "computer_relay_revoked",
                closeCode: 1008,
                closeReason: "Computer revoked",
            });
            expect(upgradeCount).toBe(1);
        } finally {
            cancellation.abort();
            await runtime.catch(() => undefined);
            encryption.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                relay.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
            restoreEnvironmentVariable("MORTY_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MORTY_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MORTY_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a healthy idle daemon connection, When the Relay sends a future event and twenty minutes pass, Then the same connection remains available", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-liveness-"));
        const encryption = await createEncryptedDaemonFrames(
            stateDirectory,
            "liveness-channel",
            AbortSignal.timeout(120_000),
        );
        const sendCommand = async (socket: Duplex, message: string): Promise<void> =>
            writeServerTextFrame(socket, await encryption.encode(message));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        let catalogRequestCount = 0;
        let observeCatalogFailure = (): void => undefined;
        const catalogFailure = new Promise<void>((resolve) => {
            observeCatalogFailure = resolve;
        });
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MORTY_API_PREFIX}/v1/computers/liveness-channel/catalog`
            ) {
                catalogRequestCount += 1;
                request.resume();
                response.writeHead(catalogRequestCount === 1 ? 503 : 204);
                response.end();
                if (catalogRequestCount === 1) {
                    observeCatalogFailure();
                }
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const daemonSockets: Duplex[] = [];
        const upgradeWaiters: Array<() => void> = [];
        const requestedUrls: string[] = [];
        const clientFrames: Array<Promise<ClientWebSocketFrame>> = [];
        let connectionCount = 0;
        const waitForUpgrade = (): Promise<void> => new Promise((resolve) => upgradeWaiters.push(resolve));
        relay.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            daemonSockets.push(socket);
            requestedUrls.push(request.url ?? "");
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            clientFrames.push(readClientFrame(socket, encryption));
            respondToClientClose(socket);
            void sendCommand(
                socket,
                encodeWorkspaceListCommand({
                    directory: ".",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: `connection-${clientFrames.length.toString()}`,
                }),
            );
            connectionCount += 1;
            upgradeWaiters.shift()?.();
        });
        await listen(relay);
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MORTY_CODEX_PATH"];
        const previousClaudePath = process.env["MORTY_CLAUDE_PATH"];
        const previousStateDirectory = process.env["MORTY_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MORTY_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MORTY_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MORTY_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createRuntimeConfig(
            {
                credentials: memoryComputerCredentials("r".repeat(43)),
                defaultWorkspace,
                computerId: "liveness-channel",
                relayUrl: new URL(
                    `ws://127.0.0.1:${readPort(relay)}${MORTY_API_PREFIX}/channels/liveness-channel/daemon`,
                ),
            },
            new RuntimeAgentDependencies([]),
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );

        vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
        vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            await catalogFailure;
            await firstConnection;
            const firstResponse = clientFrames[0];
            if (firstResponse === undefined) {
                throw new Error("Test relay did not observe the daemon response");
            }
            expect(decodeMessageKind((await firstResponse).text)).toBe(WORKSPACE_ENTRIES_KIND);
            expect(connectionCount).toBe(1);

            await vi.advanceTimersByTimeAsync(20 * 60 * 1_000);
            await vi.advanceTimersByTimeAsync(500);
            const socket = daemonSockets[0];
            if (socket === undefined) {
                throw new Error("Test relay did not retain the daemon connection");
            }
            const frames = new ClientFrameQueue(socket, encryption);
            writeServerTextFrame(
                socket,
                JSON.stringify({
                    kind: "session.future.changed",
                    requestId: "future-changed-request",
                    target: { harness: "claude", sessionId: "session-1" },
                }),
            );
            await sendCommand(
                socket,
                encodeWorkspaceListCommand({
                    directory: ".",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: "after-twenty-minutes",
                }),
            );
            // Unauthenticated future traffic is discarded, not promoted to an
            // authenticated operation failure. The next encrypted command still works.
            expect(decodeMessageKind((await frames.next()).text)).toBe(WORKSPACE_ENTRIES_KIND);
            await sendCommand(
                socket,
                JSON.stringify({ kind: "computer.diagnostics.read", requestId: "future-rejection" }),
            );
            const rejected = decodeComputerDiagnosticsResult(
                (await nextFrameOfKind(frames, "computer.diagnostics.result")).text,
            );
            expect(rejected.entries).toContainEqual(
                expect.objectContaining({
                    event: "protocol_message_discarded",
                    requestId: "unknown",
                }),
            );

            expect({ catalogRequestCount, connectionCount, requestedUrls }).toEqual({
                catalogRequestCount: 2,
                connectionCount: 1,
                requestedUrls: [`${MORTY_API_PREFIX}/channels/liveness-channel/daemon`],
            });
        } finally {
            cancellation.abort();
            await vi.runAllTimersAsync();
            await runtime;
            encryption.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                relay.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
            restoreEnvironmentVariable("MORTY_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MORTY_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MORTY_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a connected daemon, When the Relay sends unknown kinds and malformed frames, Then unknown kinds keep the connection usable and malformed frames cause a protocol close followed by recovery", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-unsupported-command-"));
        const encryption = await createEncryptedDaemonFrames(
            stateDirectory,
            "unsupported-channel",
            AbortSignal.timeout(120_000),
        );
        const sendCommand = async (socket: Duplex, message: string): Promise<void> =>
            writeServerTextFrame(socket, await encryption.encode(message));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        const relay = createServer((request, response) => {
            if (
                request.method === "PUT" &&
                request.url === `${MORTY_API_PREFIX}/v1/computers/unsupported-channel/catalog`
            ) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const upgradeWaiters: Array<() => void> = [];
        let connectionCount = 0;
        let daemonSocket: Duplex | undefined;
        const waitForUpgrade = (): Promise<void> => new Promise((resolve) => upgradeWaiters.push(resolve));
        relay.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            daemonSocket = socket;
            connectionCount += 1;
            respondToClientClose(socket);
            writeServerTextFrame(
                socket,
                JSON.stringify({
                    kind: COMPUTER_LIVENESS_READY_KIND,
                }),
            );
            upgradeWaiters.shift()?.();
        });
        await listen(relay);
        const cancellation = new AbortController();
        const previousCodexPath = process.env["MORTY_CODEX_PATH"];
        const previousClaudePath = process.env["MORTY_CLAUDE_PATH"];
        const previousStateDirectory = process.env["MORTY_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousPath = process.env["PATH"];
        process.env["MORTY_CODEX_PATH"] = join(stateDirectory, "missing-codex");
        process.env["MORTY_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
        process.env["MORTY_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        process.env["PATH"] = "";
        const config = createRuntimeConfig(
            {
                credentials: memoryComputerCredentials("r".repeat(43)),
                defaultWorkspace,
                computerId: "unsupported-channel",
                relayUrl: new URL(
                    `ws://127.0.0.1:${readPort(relay)}${MORTY_API_PREFIX}/channels/unsupported-channel/daemon`,
                ),
            },
            new RuntimeAgentDependencies([]),
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        const timer = new ControllableTimer();
        const runtime = runRuntime(config, cancellation.signal, timer);

        try {
            await firstConnection;
            const socket = daemonSocket;
            if (socket === undefined) {
                throw new Error("Test relay did not retain the daemon connection");
            }
            const frames = new ClientFrameQueue(socket, encryption);

            // A newer Relay sends a command kind this daemon version predates.
            writeServerTextFrame(
                socket,
                JSON.stringify({
                    kind: "session.future.read",
                    requestId: "future-read-request",
                    target: { harness: "claude", sessionId: "future-session" },
                }),
            );
            // The unknown command must not disturb the connection: a known command
            // on the same socket still completes.
            await sendCommand(
                socket,
                encodeWorkspaceListCommand({
                    directory: ".",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: "after-rejection",
                }),
            );
            await nextFrameOfKind(frames, WORKSPACE_ENTRIES_KIND);
            expect(connectionCount).toBe(1);

            // Additive fields must not cause a known operation to disappear.
            await sendCommand(
                socket,
                JSON.stringify({
                    kind: WORKSPACE_LIST_KIND,
                    directory: ".",
                    requestId: "extended-workspace-request",
                    futureOptions: { format: "v3" },
                }),
            );
            const extended = await nextFrameOfKind(frames, WORKSPACE_ENTRIES_KIND);
            expect(JSON.parse(extended.text).requestId).toBe("extended-workspace-request");
            expect(connectionCount).toBe(1);

            // Future binary formats are discarded before any upload can use their bytes.
            socket.write(Buffer.from([0x82, 3, 0xff, 0x00, 0x03]));
            // Unknown commands are skipped regardless of their other fields.
            writeServerTextFrame(socket, JSON.stringify({ kind: "session.future.read", requestId: "??" }));
            await sendCommand(
                socket,
                encodeWorkspaceListCommand({
                    directory: ".",
                    kind: WORKSPACE_LIST_KIND,
                    requestId: "after-second-unknown",
                }),
            );
            await nextFrameOfKind(frames, WORKSPACE_ENTRIES_KIND);
            expect(connectionCount).toBe(1);
            let currentSocket = socket;
            let currentFrames = frames;
            let expectedConnections = 1;
            for (const invalid of [
                {
                    kind: "text",
                    text: JSON.stringify({ version: 3, message: { kind: "future" } }),
                    reason: "Invalid protocol message",
                },
                { kind: "text", text: "{not-json", reason: "Invalid protocol message" },
            ] as const) {
                const retry = timer.waitForTask(500);
                writeServerTextFrame(currentSocket, invalid.text);
                let closed = await currentFrames.next();
                while (closed.opcode !== 8) {
                    closed = await currentFrames.next();
                }
                expect(closed.bytes.readUInt16BE(0)).toBe(4008);
                expect(closed.bytes.subarray(2).toString()).toBe(invalid.reason);
                const upgraded = waitForUpgrade();
                (await retry).run();
                await upgraded;
                if (daemonSocket === undefined) {
                    throw new Error("Missing recovered connection");
                }
                currentSocket = daemonSocket;
                currentFrames = new ClientFrameQueue(currentSocket, encryption);
                await sendCommand(
                    currentSocket,
                    encodeWorkspaceListCommand({
                        directory: ".",
                        kind: WORKSPACE_LIST_KIND,
                        requestId: `recovered-${expectedConnections}`,
                    }),
                );
                await nextFrameOfKind(currentFrames, WORKSPACE_ENTRIES_KIND);
                expectedConnections += 1;
                expect(connectionCount).toBe(expectedConnections);
            }
        } finally {
            cancellation.abort();
            await runtime;
            encryption.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                relay.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
            restoreEnvironmentVariable("MORTY_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MORTY_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MORTY_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            restoreEnvironmentVariable("PATH", previousPath);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a live daemon sends without acknowledgements, When it reconnects, Then it resumes live delivery without replaying prior events", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-reconciliation-"));
        const encryption = await createEncryptedDaemonFrames(
            stateDirectory,
            "reconciliation-channel",
            AbortSignal.timeout(120_000),
        );
        const sendCommand = async (socket: Duplex, message: string): Promise<void> =>
            writeServerTextFrame(socket, await encryption.encode(message));
        const defaultWorkspace = join(stateDirectory, "workspace");
        await mkdir(defaultWorkspace);
        let reconciliationRequestCount = 0;
        const relay = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (
                request.method === "PUT" &&
                url.pathname === `${MORTY_API_PREFIX}/v1/computers/reconciliation-channel/catalog`
            ) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            if (request.method === "POST" && url.pathname.endsWith("/reconciliation")) {
                reconciliationRequestCount += 1;
                request.resume();
                response.writeHead(404, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        error: {
                            code: "not_found",
                            message: "The test Relay does not retain active Turns",
                        },
                    }),
                );
                return;
            }
            response.writeHead(426);
            response.end();
        });
        const sockets = new Set<Duplex>();
        const upgradeWaiters: Array<() => void> = [];
        const daemonSockets: Duplex[] = [];
        const clientFrames: ClientFrameQueue[] = [];
        const waitForUpgrade = (): Promise<void> => new Promise((resolve) => upgradeWaiters.push(resolve));
        relay.on("connection", (socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            daemonSockets.push(socket);
            respondToClientClose(socket);
            clientFrames.push(new ClientFrameQueue(socket, encryption));
            writeServerTextFrame(
                socket,
                encodeComputerLivenessReadyEvent({
                    kind: COMPUTER_LIVENESS_READY_KIND,
                }),
            );
            if (daemonSockets.length === 2) {
                void sendCommand(
                    socket,
                    encodeWorkspaceListCommand({
                        directory: ".",
                        kind: WORKSPACE_LIST_KIND,
                        requestId: "after-reconnect",
                    }),
                );
            }
            upgradeWaiters.shift()?.();
        });
        await listen(relay);
        let cancellation = new AbortController();
        const timer = new ControllableTimer();
        // Batching is independent of liveness: frames can now arrive before a batch task is scheduled.
        const runtimeTimer: Timer = {
            schedule: (callback, milliseconds) =>
                (milliseconds === SESSION_EVENT_BATCH_WINDOW_MILLISECONDS ? systemTimer : timer).schedule(
                    callback,
                    milliseconds,
                ),
        };
        const previousFakeAcpStateDirectory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
        const previousStateDirectory = process.env["MORTY_STATE_DIRECTORY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"] = join(stateDirectory, "native");
        process.env["MORTY_STATE_DIRECTORY"] = stateDirectory;
        process.env["NO_PROXY"] = "127.0.0.1,localhost";
        process.env["no_proxy"] = "127.0.0.1,localhost";
        const config = createRuntimeConfig(
            {
                credentials: memoryComputerCredentials("r".repeat(43)),
                defaultWorkspace,
                computerId: "reconciliation-channel",
                relayUrl: new URL(
                    `ws://127.0.0.1:${readPort(relay)}${MORTY_API_PREFIX}/channels/reconciliation-channel/daemon`,
                ),
            },
            new RuntimeAgentDependencies(
                [
                    createControlledAgent(
                        (options) =>
                            new ControlledAcpConnection(
                                {
                                    harness: "codex",
                                    adapterPath: process.execPath,
                                    arguments: [fakeAgentPath],
                                    environment: options.environment,
                                },
                                options,
                            ),
                        "codex",
                        "Codex",
                        process.execPath,
                    ),
                ],
                acpAdapters,
            ),
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
        const firstConnection = waitForUpgrade();
        let runtime = runRuntime(config, cancellation.signal, runtimeTimer);

        try {
            await firstConnection;
            const firstFrame = clientFrames[0];
            if (firstFrame === undefined) {
                throw new Error("Test relay did not observe the active Agent turn");
            }
            const firstSocket = daemonSockets[0];
            if (firstSocket === undefined) {
                throw new Error("Test relay did not retain the first connection");
            }
            const startSession = async (socket: Duplex, frames: ClientFrameQueue, commandId: string) => {
                await sendCommand(
                    socket,
                    encodeSessionCreateCommand({
                        kind: "session.create",
                        requestId: commandId,
                        operationId: commandId,
                        harness: "codex",
                        directory: ".",
                        configurations: [],
                    }),
                );
                const events: SessionLiveEvent[] = [];
                for (;;) {
                    const frame = await frames.next();
                    const kind = decodeMessageKind(frame.text);
                    if (kind === "session.operation.failed") {
                        throw new Error(frame.text);
                    }
                    if (kind === SESSION_EVENT_KIND) {
                        events.push(...decodeSessionEventEnvelope(frame.text).events);
                    }
                    if (kind !== "session.ready") {
                        continue;
                    }
                    const sessionTarget = decodeSessionReadyEvent(frame.text).target;
                    await sendCommand(
                        socket,
                        encodeSessionPromptCommand({
                            kind: SESSION_PROMPT_KIND,
                            commandId,
                            requestId: commandId,
                            target: sessionTarget,
                            disposition: "append",
                            attachments: [],
                            prompt: "broadcast without viewers",
                        }),
                    );
                    return { sessionTarget, events };
                }
            };
            const first = await startSession(firstSocket, firstFrame, "reconciliation-command");
            const initialEvents = first.events;
            while (
                !initialEvents.some(
                    (event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed",
                )
            ) {
                let frame = await firstFrame.next();
                if (frame.text === COMPUTER_HEARTBEAT_MESSAGE) {
                    writeServerTextFrame(firstSocket, COMPUTER_HEARTBEAT_ACK_MESSAGE);
                    frame = await firstFrame.next();
                }
                while (decodeMessageKind(frame.text) !== SESSION_EVENT_KIND) {
                    frame = await firstFrame.next();
                }
                initialEvents.push(...decodeSessionEventEnvelope(frame.text).events);
            }
            expect(initialEvents).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "lifecycle-metadata",
                        payload: expect.objectContaining({ kind: "prompt.requested" }),
                    }),
                    expect.objectContaining({
                        type: "lifecycle-metadata",
                        payload: expect.objectContaining({ kind: "prompt.started" }),
                    }),
                    expect.objectContaining({
                        type: "lifecycle-metadata",
                        payload: expect.objectContaining({ kind: "prompt.completed" }),
                    }),
                ]),
            );
            // No delivery acknowledgements exist. Reconnection starts receiving live events.
            // More than the former 16-event window must stream without any delivery ACK.
            for (let turn = 0; turn < 6; turn += 1) {
                await sendCommand(
                    firstSocket,
                    encodeSessionPromptCommand({
                        commandId: `live-command-${turn}`,
                        requestId: `live-command-${turn}`,
                        disposition: "append",
                        attachments: [],
                        kind: SESSION_PROMPT_KIND,
                        prompt: "keep broadcasting",
                        target: first.sessionTarget,
                    }),
                );
                let terminal = false;
                let answer = "";
                while (!terminal) {
                    const frame = await firstFrame.next();
                    if (decodeMessageKind(frame.text) !== SESSION_EVENT_KIND) {
                        continue;
                    }
                    for (const event of decodeSessionEventEnvelope(frame.text).events) {
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            answer += event.payload.content.text;
                        }
                        terminal ||= event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed";
                    }
                }
                expect(answer).toContain("keep broadcasting");
            }
            const secondConnection = waitForUpgrade();
            const firstRetry = timer.waitForTask(500);
            firstSocket.destroy();
            (await firstRetry).run();
            await secondConnection;
            const resumedFrame = clientFrames[1];
            if (resumedFrame === undefined) {
                throw new Error("Test relay did not observe resumed live events");
            }
            let replayedFrame = await resumedFrame.next();
            if (replayedFrame.text === COMPUTER_HEARTBEAT_MESSAGE) {
                const secondSocket = daemonSockets[1];
                if (secondSocket === undefined) {
                    throw new Error("Test relay did not retain the replacement connection");
                }
                writeServerTextFrame(secondSocket, COMPUTER_HEARTBEAT_ACK_MESSAGE);
                replayedFrame = await resumedFrame.next();
            }
            expect(decodeMessageKind(replayedFrame.text)).toBe(WORKSPACE_ENTRIES_KIND);
            expect(reconciliationRequestCount).toBe(0);
            expect(daemonSockets).toHaveLength(2);

            // A fresh daemon also starts with live events, never an old delivery queue.
            cancellation.abort();
            await runtime;
            cancellation = new AbortController();
            const restarted = waitForUpgrade();
            runtime = runRuntime(config, cancellation.signal, runtimeTimer);
            await restarted;
            const freshFrames = clientFrames[2];
            if (freshFrames === undefined) {
                throw new Error("Test relay did not observe the restarted daemon");
            }
            const freshSocket = daemonSockets[2];
            if (freshSocket === undefined) {
                throw new Error("Missing fresh daemon connection");
            }
            const fresh = await startSession(freshSocket, freshFrames, "fresh-command");
            let freshFrame = await freshFrames.next();
            if (decodeMessageKind(freshFrame.text) === COMPUTER_HEARTBEAT_KIND) {
                freshFrame = await freshFrames.next();
            }
            while (decodeMessageKind(freshFrame.text) !== SESSION_EVENT_KIND) {
                freshFrame = await freshFrames.next();
            }
            const freshEvents = [...fresh.events, ...decodeSessionEventEnvelope(freshFrame.text).events];
            while (
                !freshEvents.some(
                    (event) =>
                        sameNativeSession(event.target, fresh.sessionTarget) &&
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.requested",
                )
            ) {
                freshFrame = await freshFrames.next();
                if (decodeMessageKind(freshFrame.text) === SESSION_EVENT_KIND) {
                    freshEvents.push(...decodeSessionEventEnvelope(freshFrame.text).events);
                }
            }
            // A restart retains terminal facts, while no earlier content or admission is replayed.
            expect(
                freshEvents
                    .filter((event) => !sameNativeSession(event.target, fresh.sessionTarget))
                    .every((event) => event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed"),
            ).toBe(true);
            expect(freshEvents).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "lifecycle-metadata",
                        payload: expect.objectContaining({ kind: "prompt.requested" }),
                    }),
                ]),
            );
            expect(decodeSessionEventEnvelope(freshFrame.text)).not.toHaveProperty("delivery");
            expect(await readdir(stateDirectory)).not.toContain("events");
        } finally {
            cancellation.abort();
            await runtime;
            encryption.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                relay.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
            restoreEnvironmentVariable("MORTY_FAKE_ACP_STATE_DIRECTORY", previousFakeAcpStateDirectory);
            restoreEnvironmentVariable("MORTY_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });
});
