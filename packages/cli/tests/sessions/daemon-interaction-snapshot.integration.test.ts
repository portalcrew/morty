import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionElicitationRequestedEvent,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    decodeSessionInteractionAnsweredEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionPermissionRequestedEvent,
    decodeSessionPromptAcceptedEvent,
    decodeSessionReadyEvent,
    decodeSessionRestoredEvent,
    decodeSessionsQueriedEvent,
    encodeNativeSessionRequest,
    encodeSessionCreateCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    encodeSessionRestoreCommand,
    MORTY_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    type NativeSessionTarget,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_EVENT_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    SESSION_PROMPT_ACCEPTED_KIND,
    SESSION_QUERIED_KIND,
    SESSION_READY_KIND,
    SESSION_RESTORED_KIND,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../support/controlled-runtime-config.ts";

class Messages {
    readonly #buffered: string[] = [];
    readonly #waiting: Array<(message: string) => void> = [];

    constructor(socket: WebSocket) {
        socket.on("message", (value) => {
            const message = value.toString();
            const resolve = this.#waiting.shift();
            if (resolve === undefined) {
                this.#buffered.push(message);
            } else {
                resolve(message);
            }
        });
    }

    readonly nextKind = async (kind: string): Promise<string> => {
        for (;;) {
            const raw = this.#buffered.shift() ?? (await new Promise<string>((resolve) => this.#waiting.push(resolve)));
            const message = raw;
            if (decodeMessageKind(raw) === SESSION_EVENT_KIND) {
                const events = decodeSessionEventEnvelope(raw).events.filter(
                    (event) => event.type === "lifecycle-metadata",
                );
                const matching = events.find(
                    (event) =>
                        "event" in event.payload && decodeMessageKind(JSON.stringify(event.payload.event)) === kind,
                );
                if (matching !== undefined && "event" in matching.payload) {
                    return JSON.stringify(matching.payload.event);
                }
                if (events.some((event) => event.payload.kind === kind)) {
                    return raw;
                }
                continue;
            }
            if (decodeMessageKind(message) === kind) {
                return message;
            }
        }
    };
}

test("Given a newly created native Session, When its first Turn resolves interactions, Then readiness is recorded and resolved interactions do not appear in its snapshot", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-interaction-snapshot-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay).toString()}${MORTY_API_PREFIX}/channels/interaction/daemon`);
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "claude",
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Claude Code"],
                    environment: options.environment,
                },
                options,
            ),
        "claude",
        "Claude Code",
        process.execPath,
        {
            MORTY_FAKE_ACP_PAUSE_AFTER_PERMISSION: "1",
            MORTY_FAKE_ACP_PAUSE_AFTER_ELICITATION: "1",
            MORTY_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "agent"),
        },
    );
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "interaction",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
        socket.send(
            encodeSessionCreateCommand({
                harness: "claude",
                directory: ".",
                kind: "session.create",
                requestId: "inspect_request",
                operationId: crypto.randomUUID(),
                configurations: [],
            }),
        );
        const sessionTarget = decodeSessionReadyEvent(await messages.nextKind(SESSION_READY_KIND)).target;
        const submittedAt = Date.now();
        socket.send(
            encodeSessionPromptCommand({
                requestId: "interaction_turn",
                commandId: "interaction_turn",
                requestId: "interaction_turn",
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "exercise ACP controls",
                target: sessionTarget,
            }),
        );
        // The prompt is answered once the Session is executing it.
        await messages.nextKind("session.prompt.accepted");
        const snapshot = async (requestId: string) => {
            socket.send(
                encodeNativeSessionRequest({
                    action: "active-turn",
                    kind: "native.session.request",
                    requestId,
                    target: sessionTarget,
                }),
            );
            return decodeNativeSessionResult(await messages.nextKind(NATIVE_SESSION_RESULT_KIND));
        };
        const permission = decodeSessionPermissionRequestedEvent(
            await messages.nextKind(SESSION_PERMISSION_REQUESTED_KIND),
        );
        expect(permission).toMatchObject({
            details: {
                cwd: await realpath(workspace),
                rawInput: { command: "pnpm test -- --reporter=verbose", target: "src/<entry>.ts" },
                locations: [{ path: "src/<entry>.ts", line: 12 }],
            },
        });
        const running = await snapshot("permission_snapshot");
        expect(running).toMatchObject({
            action: "active-turn",
            turn: { interaction: permission },
        });
        // The turn is dated by the Computer's start, not by whoever reads it.
        const startedAt = running.action === "active-turn" ? Date.parse(running.turn?.startedAt ?? "") : Number.NaN;
        expect(startedAt).toBeGreaterThanOrEqual(submittedAt);
        expect(startedAt).toBeLessThanOrEqual(Date.now());
        socket.send(
            encodeSessionPermissionRespondCommand({
                interactionId: permission.interactionId,
                kind: "session.permission.respond",
                requestId: crypto.randomUUID(),
                optionId: "allow-once",
                outcome: "selected",
                target: sessionTarget,
            }),
        );
        await messages.nextKind(SESSION_PERMISSION_RESOLVED_KIND);
        expect(await snapshot("resolved_permission_snapshot")).toMatchObject({
            action: "active-turn",
            turn: { interaction: null },
        });
        // A caller that lost the first reply can repeat its answer, but cannot overwrite it.
        const repeatedAnswer = {
            interactionId: permission.interactionId,
            kind: "session.permission.respond" as const,
            requestId: "repeat-permission",
            optionId: "allow-once",
            outcome: "selected" as const,
            target: sessionTarget,
        };
        socket.send(encodeSessionPermissionRespondCommand(repeatedAnswer));
        expect(
            decodeSessionInteractionAnsweredEvent(await messages.nextKind("session.interaction.answered")),
        ).toMatchObject({
            requestId: "repeat-permission",
            interactionId: permission.interactionId,
        });
        socket.send(
            encodeSessionPermissionRespondCommand({
                ...repeatedAnswer,
                requestId: "conflicting-permission",
                outcome: "cancelled",
            }),
        );
        expect(decodeSessionOperationFailedEvent(await messages.nextKind("session.operation.failed"))).toMatchObject({
            requestId: "conflicting-permission",
            code: "permission_response_conflict",
        });
        socket.send(
            encodeSessionQueryCommand({ kind: "session.query", requestId: "metadata-time", targets: [sessionTarget] }),
        );
        expect(decodeSessionsQueriedEvent(await messages.nextKind(SESSION_QUERIED_KIND))).toMatchObject({
            entries: [expect.objectContaining({ target: sessionTarget, updatedAt: "2026-09-04T00:01:00.000Z" })],
        });
        await writeFile(join(stateDirectory, "agent", "resume-after-permission"), "");
        const elicitation = decodeSessionElicitationRequestedEvent(
            await messages.nextKind(SESSION_ELICITATION_REQUESTED_KIND),
        );
        expect(await snapshot("elicitation_snapshot")).toMatchObject({
            action: "active-turn",
            turn: { interaction: elicitation },
        });
        socket.send(
            encodeSessionElicitationRespondCommand({
                action: "accept",
                content: JSON.stringify({ branch: "main" }),
                interactionId: elicitation.interactionId,
                kind: "session.elicitation.respond",
                requestId: crypto.randomUUID(),
                target: sessionTarget,
            }),
        );
        await messages.nextKind(SESSION_ELICITATION_RESOLVED_KIND);
        expect(await snapshot("resolved_elicitation_snapshot")).toMatchObject({
            action: "active-turn",
            turn: { interaction: null },
        });
        await writeFile(join(stateDirectory, "agent", "resume-after-elicitation"), "");
        await messages.nextKind("prompt.completed");
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given an Agent announced a tool call with its input, When it requests permission referencing only that tool call, Then the permission carries the announced input, locations and kind", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-announced-permission-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MORTY_API_PREFIX}/channels/announced-permission/daemon`,
    );
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "claude",
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Claude Code"],
                    environment: options.environment,
                },
                options,
            ),
        "claude",
        "Claude Code",
        process.execPath,
    );
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "announced-permission",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
        socket.send(
            encodeSessionCreateCommand({
                harness: "claude",
                directory: ".",
                kind: "session.create",
                requestId: "prepare_request",
                operationId: crypto.randomUUID(),
                configurations: [],
            }),
        );
        const sessionTarget = decodeSessionReadyEvent(await messages.nextKind(SESSION_READY_KIND)).target;
        socket.send(
            encodeSessionPromptCommand({
                requestId: "announced_turn",
                commandId: "announced_turn",
                requestId: "announced_turn",
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "request permission for an announced tool call",
                target: sessionTarget,
            }),
        );
        const permission = decodeSessionPermissionRequestedEvent(
            await messages.nextKind(SESSION_PERMISSION_REQUESTED_KIND),
        );
        expect(permission).toMatchObject({
            details: {
                cwd: await realpath(workspace),
                rawInput: { command: "sh scripts/release.sh --publish" },
                locations: [{ path: "scripts/release.sh", line: 3 }],
            },
            title: "Approve the release command",
            toolCallId: "announced-tool",
            toolKind: "execute",
        });
        socket.send(
            encodeSessionPermissionRespondCommand({
                interactionId: permission.interactionId,
                kind: "session.permission.respond",
                requestId: crypto.randomUUID(),
                optionId: "allow-once",
                outcome: "selected",
                target: sessionTarget,
            }),
        );
        // The Agent finishes the Turn only after it receives the permission response.
        await messages.nextKind("prompt.completed");
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given an Agent announced a tool call and then sent a rawInput null update, When it requests permission referencing only that tool call, Then the permission keeps the announced input", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-null-input-permission-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MORTY_API_PREFIX}/channels/null-input-permission/daemon`,
    );
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "claude",
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Claude Code"],
                    environment: options.environment,
                },
                options,
            ),
        "claude",
        "Claude Code",
        process.execPath,
    );
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "null-input-permission",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
        socket.send(
            encodeSessionCreateCommand({
                harness: "claude",
                directory: ".",
                kind: "session.create",
                requestId: "prepare_request",
                operationId: crypto.randomUUID(),
                configurations: [],
            }),
        );
        const sessionTarget = decodeSessionReadyEvent(await messages.nextKind(SESSION_READY_KIND)).target;
        socket.send(
            encodeSessionPromptCommand({
                requestId: "null_input_turn",
                commandId: "null_input_turn",
                requestId: "null_input_turn",
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "request permission after a null rawInput update",
                target: sessionTarget,
            }),
        );
        const permission = decodeSessionPermissionRequestedEvent(
            await messages.nextKind(SESSION_PERMISSION_REQUESTED_KIND),
        );
        expect(permission).toMatchObject({
            details: {
                cwd: await realpath(workspace),
                rawInput: { command: "sh scripts/release.sh --publish" },
                locations: [{ path: "scripts/release.sh", line: 3 }],
            },
            title: "Approve the release command",
            toolCallId: "null-input-tool",
            toolKind: "execute",
        });
        socket.send(
            encodeSessionPermissionRespondCommand({
                interactionId: permission.interactionId,
                kind: "session.permission.respond",
                requestId: crypto.randomUUID(),
                optionId: "allow-once",
                outcome: "selected",
                target: sessionTarget,
            }),
        );
        // The Agent finishes the Turn only after it receives the permission response.
        await messages.nextKind("prompt.completed");
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given an Agent's first recorded form of a tool call is an update, When it requests permission referencing only that tool call, Then the permission carries the update's input, locations and kind", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-orphan-update-permission-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MORTY_API_PREFIX}/channels/orphan-update-permission/daemon`,
    );
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "claude",
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Claude Code"],
                    environment: options.environment,
                },
                options,
            ),
        "claude",
        "Claude Code",
        process.execPath,
    );
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "orphan-update-permission",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
        socket.send(
            encodeSessionCreateCommand({
                harness: "claude",
                directory: ".",
                kind: "session.create",
                requestId: "prepare_request",
                operationId: crypto.randomUUID(),
                configurations: [],
            }),
        );
        const sessionTarget = decodeSessionReadyEvent(await messages.nextKind(SESSION_READY_KIND)).target;
        socket.send(
            encodeSessionPromptCommand({
                requestId: "orphan_update_turn",
                commandId: "orphan_update_turn",
                requestId: "orphan_update_turn",
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "request permission for an orphan update announcement",
                target: sessionTarget,
            }),
        );
        const permission = decodeSessionPermissionRequestedEvent(
            await messages.nextKind(SESSION_PERMISSION_REQUESTED_KIND),
        );
        expect(permission).toMatchObject({
            details: {
                cwd: await realpath(workspace),
                rawInput: { url: "https://example.test/permissions" },
                locations: [{ path: "docs/permissions.md", line: 7 }],
            },
            title: "Approve the fetch",
            toolCallId: "orphan-update-tool",
            toolKind: "fetch",
        });
        socket.send(
            encodeSessionPermissionRespondCommand({
                interactionId: permission.interactionId,
                kind: "session.permission.respond",
                requestId: crypto.randomUUID(),
                optionId: "allow-once",
                outcome: "selected",
                target: sessionTarget,
            }),
        );
        // The Agent finishes the Turn only after it receives the permission response.
        await messages.nextKind("prompt.completed");
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given a real daemon prepared a Session, When Relay queries its metadata, Then the daemon returns it without closing the Computer", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-session-query-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MORTY_API_PREFIX}/channels/session-query/daemon`,
    );
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "codex",
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Codex"],
                    environment: options.environment,
                },
                options,
            ),
        "codex",
        "Codex",
        process.execPath,
    );
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "session-query",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
        socket.send(
            encodeSessionCreateCommand({
                harness: "codex",
                directory: ".",
                kind: "session.create",
                requestId: "prepare_request",
                operationId: crypto.randomUUID(),
                configurations: [],
            }),
        );
        const sessionTarget = decodeSessionReadyEvent(await messages.nextKind(SESSION_READY_KIND)).target;

        socket.send(
            encodeSessionQueryCommand({
                kind: "session.query",
                requestId: "query_request",
                targets: [sessionTarget],
            }),
        );

        expect(decodeSessionsQueriedEvent(await messages.nextKind(SESSION_QUERIED_KIND))).toMatchObject({
            entries: [
                {
                    harness: "codex",
                    prompted: false,
                    target: sessionTarget,
                    status: { kind: "idle" },
                    title: "Untitled session",
                },
            ],
            requestId: "query_request",
        });
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given a real daemon persisted a Session, When Relay restores it by identifier, Then history is loaded once and remains available for paging", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-session-restore-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MORTY_API_PREFIX}/channels/session-restore/daemon`,
    );
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "codex",
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Codex", "--replay-history-once"],
                    environment: options.environment,
                },
                options,
            ),
        "codex",
        "Codex",
        process.execPath,
        { MORTY_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "agent") },
    );
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "session-restore",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const startDaemon = async () => {
        const connected = Promise.withResolvers<WebSocket>();
        websocketServer.once("connection", (socket) => connected.resolve(socket));
        const cancellation = new AbortController();
        const completion = runRuntime(config, cancellation.signal);
        return { cancellation, completion, socket: await connected.promise };
    };
    try {
        let sessionTarget: NativeSessionTarget;
        const initial = await startDaemon();
        try {
            const messages = new Messages(initial.socket);
            initial.socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
            initial.socket.send(
                encodeSessionCreateCommand({
                    harness: "codex",
                    directory: ".",
                    kind: "session.create",
                    requestId: "prepare_request",
                    operationId: crypto.randomUUID(),
                    configurations: [],
                }),
            );
            sessionTarget = decodeSessionReadyEvent(await messages.nextKind(SESSION_READY_KIND)).target;
            initial.socket.send(
                encodeSessionPromptCommand({
                    requestId: "initial_turn",
                    commandId: "initial_turn",
                    requestId: "initial_turn",
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "Persist this Session",
                    target: sessionTarget,
                }),
            );
            await messages.nextKind("prompt.completed");
        } finally {
            initial.cancellation.abort();
            await initial.completion;
        }

        const restored = await startDaemon();
        try {
            const messages = new Messages(restored.socket);
            restored.socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
            restored.socket.send(
                encodeSessionQueryCommand({
                    kind: "session.query",
                    requestId: "identify_restore",
                    targets: [sessionTarget],
                }),
            );
            const [entry] = decodeSessionsQueriedEvent(await messages.nextKind("session.queried")).entries;
            if (entry === undefined) {
                throw new Error("Missing persisted native identity");
            }
            restored.socket.send(
                encodeSessionRestoreCommand({
                    kind: "session.restore",
                    requestId: "restore_request",
                    target: { harness: entry.harness, sessionId: entry.sessionId },
                }),
            );

            const restoredEvent = decodeSessionRestoredEvent(await messages.nextKind(SESSION_RESTORED_KIND));
            expect(restoredEvent).toMatchObject({
                entry: {
                    harness: "codex",
                    prompted: true,
                    target: sessionTarget,
                    status: { kind: "idle" },
                    title: "Persist this Session",
                },
                kind: SESSION_RESTORED_KIND,
                ready: {
                    harness: "codex",
                    kind: SESSION_READY_KIND,
                    requestId: "restore_request",
                    restored: true,
                    target: sessionTarget,
                },
                requestId: "restore_request",
            });
            expect(restoredEvent.ready.runtimeTimings?.map((timing) => timing.name)).toContain("session-load");
            expect(restoredEvent.ready.runtimeTimings?.map((timing) => timing.name)).not.toContain("session-resume");

            restored.socket.send(
                encodeSessionHistoryPageLoad({
                    cursor: null,
                    eventLimit: 200,
                    kind: "session.live-history.v2.page.load",
                    requestId: "history_request",
                    target: sessionTarget,
                }),
            );
            const history = decodeSessionHistoryPageLoaded(
                await messages.nextKind("session.live-history.v2.page.loaded"),
            );
            expect(JSON.stringify(history.events.events.events)).toContain("Persist this Session");
        } finally {
            restored.cancellation.abort();
            await restored.completion;
        }
    } finally {
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given a running turn and a queued prompt with a file, When an active-turn snapshot names only the Session, Then it reports the queued prompt with that prompt's files", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "morty-queued-identity-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MORTY_API_PREFIX}/channels/queued-identity/daemon`,
    );
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "claude",
                    adapterPath: process.execPath,
                    arguments: [fakeAgentPath, "--agent-name", "Claude Code"],
                    environment: options.environment,
                },
                options,
            ),
        "claude",
        "Claude Code",
        process.execPath,
        {
            MORTY_FAKE_ACP_PAUSE_AFTER_PERMISSION: "1",
            MORTY_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "agent"),
        },
    );
    const config = createRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "queued-identity",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        new RuntimeLocalContext(stateDirectory, process.env),
        async (agent) => agent,
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "computer.liveness.ready" }));
        socket.send(
            encodeSessionCreateCommand({
                kind: "session.create",
                requestId: crypto.randomUUID(),
                operationId: crypto.randomUUID(),
                harness: "claude",
                directory: ".",
                configurations: [],
            }),
        );
        const sessionTarget = decodeSessionReadyEvent(await messages.nextKind(SESSION_READY_KIND)).target;
        socket.send(
            encodeSessionPromptCommand({
                requestId: "running_turn",
                commandId: "running_turn",
                requestId: "running_turn",
                disposition: SessionPromptDisposition.Append,
                attachments: [],
                kind: "session.prompt",
                prompt: "exercise ACP controls",
                target: sessionTarget,
            }),
        );
        // The prompt is answered once the Session is executing it.
        await messages.nextKind("session.prompt.accepted");
        // A prompt with a file queues behind the running turn; a client needs the file to restore it for editing.
        const report = {
            byteLength: 17,
            contentKey: "a".repeat(64),
            kind: "resource" as const,
            mimeType: "text/plain",
            name: "report.txt",
            uri: "attachment:///report.txt",
        };
        socket.send(
            encodeSessionPromptCommand({
                requestId: "own_queued_turn",
                commandId: "own_queued_turn",
                requestId: "own_queued_turn",
                disposition: SessionPromptDisposition.Append,
                attachments: [report],
                kind: "session.prompt",
                prompt: "summarize the attached report",
                target: sessionTarget,
            }),
        );
        // A client reads the queue once the Computer has answered that the prompt waits in it.
        for (;;) {
            const accepted = decodeSessionPromptAcceptedEvent(await messages.nextKind(SESSION_PROMPT_ACCEPTED_KIND));
            if (accepted.requestId === "own_queued_turn") {
                expect(accepted.state).toBe("queued");
                break;
            }
        }
        socket.send(
            encodeNativeSessionRequest({
                action: "active-turn",
                kind: "native.session.request",
                requestId: "session_snapshot",
                target: sessionTarget,
            }),
        );
        const result = decodeNativeSessionResult(await messages.nextKind(NATIVE_SESSION_RESULT_KIND));
        expect(result.action).toBe("active-turn");
        if (result.action === "active-turn") {
            expect(result.queued).toEqual([
                {
                    commandId: "own_queued_turn",
                    prompt: "summarize the attached report",
                    attachments: [report],
                },
            ]);
            expect(result.turn?.commandId).toBe("running_turn");
        }
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);
