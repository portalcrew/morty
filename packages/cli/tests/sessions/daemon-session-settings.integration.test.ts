import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    decodeAgentSettingsDiscoveredEvent,
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeSessionCreateCommand,
    encodeSessionPromptCommand,
    MORTY_API_PREFIX,
    type NativeSessionTarget,
    SESSION_EVENT_KIND,
    type SessionLiveEvent,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { listen, port, sendText } from "@morty-build/relay-test-support/websocket";
import { describe, expect, it } from "vitest";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../support/controlled-runtime-config.ts";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class ClientFrames {
    #buffered = Buffer.alloc(0);
    readonly #messages: string[] = [];
    readonly #resolvers: Array<(message: string) => void> = [];

    constructor(socket: Duplex) {
        socket.on("data", (chunk: Buffer) => {
            this.#buffered = Buffer.concat([this.#buffered, chunk]);
            this.decode();
        });
    }

    readonly next = (): Promise<string> => {
        const message = this.#messages.shift();
        if (message !== undefined) {
            return Promise.resolve(message);
        }
        return new Promise((resolve) => this.#resolvers.push(resolve));
    };

    private readonly decode = (): void => {
        while (this.#buffered.byteLength >= 6) {
            const encodedLength = this.#buffered.readUInt8(1) & 0x7f;
            if (encodedLength === 127) {
                throw new Error("Test relay received an oversized daemon frame");
            }
            const headerLength = encodedLength === 126 ? 4 : 2;
            if (this.#buffered.byteLength < headerLength + 4) {
                return;
            }
            const payloadLength = encodedLength === 126 ? this.#buffered.readUInt16BE(2) : encodedLength;
            const frameLength = headerLength + 4 + payloadLength;
            if (this.#buffered.byteLength < frameLength) {
                return;
            }
            const opcode = this.#buffered.readUInt8(0) & 0x0f;
            const mask = this.#buffered.subarray(headerLength, headerLength + 4);
            const payload = Buffer.from(this.#buffered.subarray(headerLength + 4, frameLength));
            this.#buffered = this.#buffered.subarray(frameLength);
            for (let index = 0; index < payload.byteLength; index += 1) {
                payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
            }
            if (opcode !== 1) {
                continue;
            }
            const message = payload.toString("utf8");
            const resolve = this.#resolvers.shift();
            if (resolve === undefined) {
                this.#messages.push(message);
            } else {
                resolve(message);
            }
        }
    };
}

class TerminalSessionResult {
    readonly code: string;
    readonly kind: string;
    readonly stopReason: string;
    readonly text: string;

    constructor(kind: string, text: string, code: string, stopReason: string) {
        this.code = code;
        this.kind = kind;
        this.stopReason = stopReason;
        this.text = text;
    }
}

const bufferedSessionEvents = new WeakMap<ClientFrames, SessionLiveEvent[]>();

async function createSession(socket: Duplex, frames: ClientFrames, harness: string): Promise<NativeSessionTarget> {
    sendText(
        socket,
        encodeSessionCreateCommand({
            kind: "session.create",
            requestId: crypto.randomUUID(),
            operationId: crypto.randomUUID(),
            harness,
            directory: ".",
            configurations: [],
        }),
    );
    for (;;) {
        const message = await frames.next();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind === "session.ready") {
            return decodeSessionReadyEvent(message).target;
        }
    }
}

async function readTerminalSessionResult(
    frames: ClientFrames,
    sessionTarget: NativeSessionTarget,
    commandId = "",
    includeAcpText = true,
): Promise<TerminalSessionResult> {
    let text = "";
    const deferredEvents: SessionLiveEvent[] = [];
    for (;;) {
        let events = bufferedSessionEvents.get(frames) ?? [];
        bufferedSessionEvents.delete(frames);
        if (events.length === 0) {
            const message = await frames.next();
            if (decodeMessageKind(message) === "session.operation.failed") {
                const failure = decodeSessionOperationFailedEvent(message);
                if (
                    failure.target !== undefined &&
                    sameNativeSession(failure.target, sessionTarget) &&
                    (commandId === "" || failure.requestId === commandId)
                ) {
                    return new TerminalSessionResult("failed", text, failure.code, "");
                }
            }
            if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
                continue;
            }
            events = [...decodeSessionEventEnvelope(message).events];
        }
        for (const [index, event] of events.entries()) {
            if (!sameNativeSession(event.target, sessionTarget)) {
                continue;
            }
            if (event.type === "acp") {
                if (event.payload.sessionUpdate === "agent_message_chunk" && event.payload.content.type === "text") {
                    if (includeAcpText) {
                        text += event.payload.content.text;
                    } else {
                        deferredEvents.push(event);
                    }
                }
                continue;
            }
            const payload = event.payload;
            if (!("commandId" in payload) || (commandId !== "" && payload.commandId !== commandId)) {
                continue;
            }
            if (payload.kind === "prompt.completed") {
                bufferedSessionEvents.set(frames, [...deferredEvents, ...events.slice(index + 1)]);
                return new TerminalSessionResult("completed", text, "", payload.stopReason);
            }
            if (payload.kind === "prompt.failed" || payload.kind === "prompt.failed-before-start") {
                bufferedSessionEvents.set(frames, [...deferredEvents, ...events.slice(index + 1)]);
                return new TerminalSessionResult("failed", text, payload.code, "");
            }
        }
    }
}
async function readCommandActivity(
    frames: ClientFrames,
    sessionTarget: NativeSessionTarget,
    _commandId: string,
): Promise<void> {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
            continue;
        }
        if (
            decodeSessionEventEnvelope(message).events.some(
                (event) =>
                    sameNativeSession(event.target, sessionTarget) &&
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update"),
            )
        ) {
            return;
        }
    }
}

async function readAgentSettings(frames: ClientFrames, requestId: string) {
    for (;;) {
        const message = await frames.next();
        if (decodeMessageKind(message) !== AGENT_SETTINGS_DISCOVERED_KIND) {
            continue;
        }
        const discovered = decodeAgentSettingsDiscoveredEvent(message);
        if (discovered.requestId === requestId) {
            return discovered;
        }
    }
}

describe("daemon session configuration boundary", () => {
    it("Given Codex removes a model between capability probes, When settings are discovered, Then the daemon returns supported settings and records the unavailable value", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-changing-model-catalog-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            const accept = createHash("sha1")
                .update(`${key ?? ""}${websocketGuid}`)
                .digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "computer.liveness.ready" }));
            socketReady.resolve(socket);
        });
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/channel_alpha/daemon`);
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "codex",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--change-model-catalog-after-first-process"],
                        environment: options.environment,
                    },
                    options,
                ),
            "codex",
            "Codex",
            process.execPath,
            { MORTY_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory },
        );
        const config = createRuntimeConfig(
            {
                computerId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
                credentials: memoryComputerCredentials("d".repeat(43)),
            },
            [agent],
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const requestId = "codex-changing-model-catalog";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    harness: agent.harness,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId,
                }),
            );
            const discovered = await readAgentSettings(frames, requestId);
            expect(discovered.modelEffort).toMatchObject({
                resolution: "complete",
                unsupportedModelIds: ["test-large"],
                valuesByModel: { "test-small": expect.any(Array) },
            });
            const model = discovered.settings.find((setting) => setting.id === "model");
            expect(model).toMatchObject({ type: "select", values: [expect.objectContaining({ value: "test-small" })] });
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            await runtime;
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an Agent withholds effort for its default model, When settings are discovered without a model, Then the default model's own capability is reported", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-default-effort-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            const accept = createHash("sha1")
                .update(`${key ?? ""}${websocketGuid}`)
                .digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "computer.liveness.ready" }));
            socketReady.resolve(socket);
        });
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/channel_alpha/daemon`);
        // The Agent withholds reasoning effort for its default model, so a
        // session that never switches models must still learn that model's
        // capability instead of offering no effort control at all.
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [fakeAgentPath, "--agent-name", "Controlled ACP", "--without-reasoning-effort"],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            },
        );
        const config = createRuntimeConfig(
            {
                computerId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
                credentials: memoryComputerCredentials("d".repeat(43)),
            },
            [agent],
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const noEffortRequestId = "controlled-settings-without-effort";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    harness: agent.harness,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId: noEffortRequestId,
                }),
            );
            const withoutEffort = await readAgentSettings(frames, noEffortRequestId);
            expect(withoutEffort.modelEffort).toEqual({
                effortSettingId: "",
                modelSettingId: "model",
                resolution: "on_model_selection",
                unsupportedModelIds: [],
                valuesByModel: { "test-small": [] },
            });
            expect(withoutEffort.settings).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ id: "reasoning_effort" })]),
            );
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            await runtime;
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a project directory whose Agent settings choose another model, When settings are discovered for that directory, Then the daemon reports that directory's default model", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-directory-settings-"));
        const workspace = join(stateDirectory, "workspace");
        const project = join(stateDirectory, "project");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([
            mkdir(workspace),
            mkdir(join(project, ".claude"), { recursive: true }),
            mkdir(nativeStateDirectory),
        ]);
        await writeFile(join(project, ".claude", "settings.json"), JSON.stringify({ model: "test-large" }));
        const projectDirectory = await realpath(project);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            const accept = createHash("sha1")
                .update(`${key ?? ""}${websocketGuid}`)
                .digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "computer.liveness.ready" }));
            socketReady.resolve(socket);
        });
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
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            },
        );
        const config = createRuntimeConfig(
            {
                computerId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
                credentials: memoryComputerCredentials("d".repeat(43)),
            },
            [agent],
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            sendText(
                socket,
                encodeAgentSettingsDiscoverCommand({
                    harness: agent.harness,
                    directory: projectDirectory,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId: "controlled-settings-in-project",
                }),
            );
            const inProject = await readAgentSettings(frames, "controlled-settings-in-project");
            expect(inProject.directory).toBe(projectDirectory);
            expect(inProject.settings).toContainEqual(
                expect.objectContaining({ defaultValue: "test-large", id: "model" }),
            );

            sendText(
                socket,
                encodeAgentSettingsDiscoverCommand({
                    harness: agent.harness,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId: "controlled-settings-in-default",
                }),
            );
            const inDefault = await readAgentSettings(frames, "controlled-settings-in-default");
            expect(inDefault.directory).toBe(".");
            expect(inDefault.settings).toContainEqual(
                expect.objectContaining({ defaultValue: "test-small", id: "model" }),
            );
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            await runtime;
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an Agent offers a single model and withholds its effort, When settings are discovered without a model, Then that model is reported without effort", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-single-model-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            const accept = createHash("sha1")
                .update(`${key ?? ""}${websocketGuid}`)
                .digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "computer.liveness.ready" }));
            socketReady.resolve(socket);
        });
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/channel_alpha/daemon`);
        // A Pi user with one configured non-reasoning model: the model cannot be
        // switched and no effort is offered, so discovery must still succeed.
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [
                            fakeAgentPath,
                            "--agent-name",
                            "Controlled ACP",
                            "--without-reasoning-effort",
                            "--acp-omits-custom-model",
                        ],
                        environment: options.environment,
                    },
                    options,
                ),
            "controlled-acp",
            "Controlled ACP",
            process.execPath,
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            },
        );
        const config = createRuntimeConfig(
            {
                computerId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
                credentials: memoryComputerCredentials("d".repeat(43)),
            },
            [agent],
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const noEffortRequestId = "controlled-settings-single-model";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    harness: agent.harness,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId: noEffortRequestId,
                }),
            );
            const withoutEffort = await readAgentSettings(frames, noEffortRequestId);
            expect(withoutEffort.modelEffort).toEqual({
                effortSettingId: "",
                modelSettingId: "model",
                resolution: "on_model_selection",
                unsupportedModelIds: [],
                valuesByModel: { "test-small": [] },
            });
            expect(withoutEffort.settings).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ id: "reasoning_effort" })]),
            );
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            await runtime;
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an Agent offers effort for its default model, When settings are discovered without a model, Then the session can adjust effort without switching models", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-default-effort-offered-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                request.resume();
                response.writeHead(204);
                response.end();
                return;
            }
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            const accept = createHash("sha1")
                .update(`${key ?? ""}${websocketGuid}`)
                .digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "computer.liveness.ready" }));
            socketReady.resolve(socket);
        });
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
            {
                MORTY_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            },
        );
        const config = createRuntimeConfig(
            {
                computerId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
                credentials: memoryComputerCredentials("d".repeat(43)),
            },
            [agent],
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const frames = new ClientFrames(await socketReady.promise);
            const requestId = "controlled-default-model-effort";
            sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    harness: agent.harness,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId,
                }),
            );
            const discovered = await readAgentSettings(frames, requestId);
            expect(discovered.settings).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        id: "reasoning_effort",
                        values: expect.arrayContaining([expect.objectContaining({ value: "medium" })]),
                    }),
                ]),
            );
            expect(discovered.modelEffort).toEqual({
                effortSettingId: "reasoning_effort",
                modelSettingId: "model",
                resolution: "on_model_selection",
                unsupportedModelIds: [],
                valuesByModel: {
                    "test-small": expect.arrayContaining([expect.objectContaining({ value: "medium" })]),
                },
            });
        } finally {
            cancellation.abort();
            for (const socket of relaySockets) {
                socket.destroy();
            }
            relay.close();
            await runtime;
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a Turn is running with an Agent settings snapshot, When a steering prompt reuses that snapshot while the live Session exposes fewer settings, Then the Agent receives the steering prompt", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-steer-settings-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "computer.liveness.ready" }));
            socketReady.resolve(socket);
        });
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/channel_alpha/daemon`);
        // The Agent reveals reasoning effort only for test-large, so the settings
        // snapshot that names it cannot match a Session parked on test-small.
        const agent = createControlledAgent(
            (options) =>
                new ControlledAcpConnection(
                    {
                        harness: "controlled-acp",
                        adapterPath: process.execPath,
                        arguments: [
                            fakeAgentPath,
                            "--agent-name",
                            "Controlled ACP",
                            "--reasoning-effort-for-test-large-only",
                        ],
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
                computerId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
                credentials: memoryComputerCredentials("d".repeat(43)),
            },
            [agent],
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            const sessionTarget = await createSession(socket, frames, agent.harness);
            const runningCommandId = "running_configured_turn";
            const runningPrompt: SessionPromptCommand = {
                commandId: runningCommandId,
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "wait for steering",
                sessionConfigurations: [
                    { configId: "removed_access_mode", value: "read-only", type: "select" },
                    { configId: "model", value: "test-small", type: "select" },
                    { configId: "reasoning_effort", value: "high", type: "select" },
                    { booleanValue: true, configId: "fast_mode", type: "boolean" },
                    { configId: "mode", value: "code", type: "select" },
                ],
                target: sessionTarget,
            };
            sendText(socket, encodeSessionPromptCommand(runningPrompt));
            await readCommandActivity(frames, sessionTarget, runningCommandId);

            const steeringPrompt: SessionPromptCommand = {
                ...runningPrompt,
                commandId: "steering_configured_turn",
                disposition: SessionPromptDisposition.Steer,
                prompt: "focus on the requested fix",
                targetCommandId: runningCommandId,
            };
            sendText(socket, encodeSessionPromptCommand(steeringPrompt));

            // The steering Turn is accepted and then injected into the running
            // Turn, so only the running Turn carries the Agent's reply.
            const steeringResult = await readTerminalSessionResult(
                frames,
                sessionTarget,
                steeringPrompt.commandId,
                false,
            );
            expect(steeringResult).toMatchObject({ kind: "completed", text: "" });
            const runningResult = await readTerminalSessionResult(frames, sessionTarget, runningCommandId);
            expect(runningResult.kind).toBe("completed");
            expect(runningResult.text).toContain("Steered: focus on the requested fix");
        } finally {
            cancellation.abort();
            await runtime;
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);

    it("Given a Turn runs with a settings snapshot, When a steering prompt names a setting value the live Session does not hold, Then the Agent receives the steering prompt", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-steer-drifted-settings-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory)]);

        const socketReady = Promise.withResolvers<Duplex>();
        const relaySockets = new Set<Duplex>();
        const relay = createServer((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        relay.on("connection", (socket) => {
            relaySockets.add(socket);
            socket.once("close", () => relaySockets.delete(socket));
            socket.on("error", () => undefined);
        });
        relay.on("upgrade", (request, socket) => {
            const key = request.headers["sec-websocket-key"];
            if (typeof key !== "string") {
                socket.destroy();
                return;
            }
            const accept = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Upgrade: websocket\r\n" +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            );
            sendText(socket, JSON.stringify({ kind: "computer.liveness.ready" }));
            socketReady.resolve(socket);
        });
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/channel_alpha/daemon`);
        // This Agent exposes reasoning effort for every model, so the live Session holds the
        // effort the running Turn configured and a steering Turn naming another one drifts
        // from it instead of naming a setting the Session does not expose at all.
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
                computerId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
                credentials: memoryComputerCredentials("d".repeat(43)),
            },
            [agent],
            new RuntimeLocalContext(stateDirectory, process.env),
            async (agent) => agent,
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const socket = await socketReady.promise;
            const frames = new ClientFrames(socket);
            const sessionTarget = await createSession(socket, frames, agent.harness);
            const runningCommandId = "running_drifted_settings_turn";
            const runningPrompt: SessionPromptCommand = {
                commandId: runningCommandId,
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "wait for steering",
                sessionConfigurations: [
                    { configId: "model", value: "test-small", type: "select" },
                    { configId: "reasoning_effort", value: "high", type: "select" },
                ],
                target: sessionTarget,
            };
            sendText(socket, encodeSessionPromptCommand(runningPrompt));
            await readCommandActivity(frames, sessionTarget, runningCommandId);

            // Steering cannot reconfigure a running Agent, so the member's newer effort
            // reaches this Turn as a snapshot the live Session does not hold yet.
            const steeringPrompt: SessionPromptCommand = {
                ...runningPrompt,
                commandId: "steering_drifted_settings_turn",
                disposition: SessionPromptDisposition.Steer,
                prompt: "focus on the requested fix",
                sessionConfigurations: [
                    { configId: "model", value: "test-small", type: "select" },
                    { configId: "reasoning_effort", value: "medium", type: "select" },
                ],
                targetCommandId: runningCommandId,
            };
            sendText(socket, encodeSessionPromptCommand(steeringPrompt));

            // The steering Turn is accepted and then injected into the running
            // Turn, so only the running Turn carries the Agent's reply.
            const steeringResult = await readTerminalSessionResult(
                frames,
                sessionTarget,
                steeringPrompt.commandId,
                false,
            );
            expect(steeringResult).toMatchObject({ kind: "completed", code: "", text: "" });
            const runningResult = await readTerminalSessionResult(frames, sessionTarget, runningCommandId);
            expect(runningResult.kind).toBe("completed");
            expect(runningResult.text).toContain("Steered: focus on the requested fix");
        } finally {
            cancellation.abort();
            await runtime;
            for (const socket of relaySockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
        }
    }, 30_000);
});
