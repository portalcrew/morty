import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    COMPUTER_LIVENESS_READY_KIND,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    decodeSessionPromptAcceptedEvent,
    decodeSessionReadyEvent,
    encodeComputerLivenessReadyEvent,
    encodeNativeSessionCommand,
    encodeSessionCreateCommand,
    isPromptTerminal,
    MORTY_API_PREFIX,
    type NativeSessionTarget,
    SESSION_EVENT_KIND,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { type WebSocket, WebSocketServer } from "ws";
import { collectLocalDaemonLogs } from "../../../src/cli/handler/logs/logic/collect-local-logs.ts";
import { sendLocalRequest } from "../../../src/daemon/control/local-client.ts";
import { decodeLifecycleResponse } from "../../../src/daemon/control/protocol.ts";
import { openMortyInstallation } from "../../../src/daemon/pairing/pair-local-computer.ts";
import { harnessAdapters } from "../../../src/engine/acp/adapter/registry.ts";
import type { AdapterResolver } from "../../../src/engine/acp/native-history/preview-contract.ts";
import { discoverLocalAgentInventory } from "../../../src/engine/agent/discovery/discover-local-agents.ts";
import type { LocalAgentSpecification } from "../../../src/engine/agent/specification/agent-specification.ts";
import {
    createRuntimeConfig,
    RuntimeAgentDependencies,
    RuntimeLocalContext,
} from "../../../src/engine/runtime/config.ts";
import {
    HEARTBEAT_ACK_TIMEOUT_MILLISECONDS,
    HEARTBEAT_INTERVAL_MILLISECONDS,
} from "../../../src/engine/runtime/relay/liveness.ts";
import { runRuntime } from "../../../src/engine/runtime/run.ts";
import { AgentProcessPool } from "../../../src/engine/session/process/agent-process-pool.ts";
import { systemTimer, type Timer } from "../../../src/engine/util/timer.ts";
import { acpAdapters } from "../acp-adapters.ts";
import { memoryComputerCredentials } from "../computer-credentials.ts";
import { createEncryptedDaemonFrames } from "../encrypted-daemon-frames.ts";

export interface DaemonConnectionPeer {
    /** Runs a `morty` command against this daemon's installation, as the user's terminal would. */
    readonly cli: (args: readonly string[]) => Promise<void>;
    readonly restart: (mode?: "crash", restoreFiles?: () => Promise<void>) => Promise<void>;
    readonly stateDirectory: string;
    readonly send: (message: string | Uint8Array) => void;
    readonly subscribe: (target: NativeSessionTarget) => Promise<void>;
    readonly workspace: string;

    readonly readDiagnostics: () => Promise<string>;
    readonly signal: AbortSignal;
    readonly nextEvent: () => Promise<string>;
    readonly nextFrame: () => Promise<string | Buffer>;
    readonly nextMessage: () => Promise<string>;
}

export interface RealDaemonPeer extends DaemonConnectionPeer {
    readonly target: NativeSessionTarget;
}

/** Controlled ACP harness registered explicitly, without changing real-Agent compatibility wiring. */
export const withControlledDaemon = (
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
    launch: "embedded" | "managed" = "embedded",
    workspaceDirectory?: string,
    timer: Timer = systemTimer,
): Promise<void> =>
    withRealDaemon(specification, environment, scenario, launch, workspaceDirectory, timer, acpAdapters);

/**
 * Scenarios own time: the relay heartbeat's wall-clock deadlines never expire, so a slow host cannot close the
 * connection in the middle of a scenario. The connection liveness tests drive those deadlines with their own clock.
 */
function withoutRelayLivenessDeadlines(timer: Timer): Timer {
    return {
        schedule: (callback, milliseconds) =>
            milliseconds === HEARTBEAT_ACK_TIMEOUT_MILLISECONDS || milliseconds === HEARTBEAT_INTERVAL_MILLISECONDS
                ? { cancel: () => undefined }
                : timer.schedule(callback, milliseconds),
    };
}

/** Production daemon and discovery; the peer only sends and observes the public protocol. */
export async function withRealDaemon(
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
    launch: "embedded" | "managed" = "embedded",
    workspaceDirectory?: string,
    timer: Timer = systemTimer,
    adapters: AdapterResolver = harnessAdapters,
): Promise<void> {
    await withDaemonConnection(
        specification,
        environment,
        async (connection) => {
            const target = await prepareNewRealSession(connection, specification.harness);
            await scenario({ ...connection, target });
        },
        launch,
        workspaceDirectory,
        timer,
        adapters,
    );
}

export const withControlledDaemonConnection = (
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: DaemonConnectionPeer) => Promise<void>,
    launch: "embedded" | "managed" = "embedded",
): Promise<void> =>
    withDaemonConnection(specification, environment, scenario, launch, undefined, systemTimer, acpAdapters);

export const withRealDaemonConnection = (
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: DaemonConnectionPeer) => Promise<void>,
    launch: "embedded" | "managed" = "embedded",
): Promise<void> =>
    withDaemonConnection(specification, environment, scenario, launch, undefined, systemTimer, harnessAdapters);

async function withDaemonConnection(
    specification: LocalAgentSpecification,
    environment: Readonly<Record<string, string>>,
    scenario: (peer: DaemonConnectionPeer) => Promise<void>,
    launch: "embedded" | "managed",
    workspaceDirectory: string | undefined,
    timer: Timer,
    adapters: AdapterResolver,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), `morty-real-${specification.harness}-`));
    const workspace = workspaceDirectory ?? join(directory, "workspace");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const catalogs = new Map<string, string>();
    const relay = createServer((request, response) => {
        if (request.method === "PUT" && request.url?.endsWith("/catalog")) {
            const path = request.url;
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
                body += chunk;
            });
            request.on("end", () => {
                catalogs.set(path, body);
                response.writeHead(204).end();
            });
        } else if (request.method === "GET" && request.url !== undefined && catalogs.has(request.url)) {
            response.writeHead(200, { "content-type": "application/json" }).end(catalogs.get(request.url));
        } else {
            response.writeHead(404).end();
        }
    });
    const server = new WebSocketServer({ server: relay });
    const runtimeTimer = withoutRelayLivenessDeadlines(timer);
    let runtime: Promise<void> | undefined;
    let execution = new AbortController();
    const cliEnvironment = { ...process.env, ...environment, MORTY_STATE_DIRECTORY: join(directory, "state") };
    const cli = async (args: readonly string[], deadline = signal): Promise<void> => {
        const child = spawn(
            process.execPath,
            [resolve(import.meta.dirname, "../../../src/cli/entrypoint.ts"), ...args],
            {
                env: cliEnvironment,
                signal: deadline,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        await new Promise<void>((resolve_, reject) => {
            child.once("error", (cause) => reject(new Error(`CLI ${args.join(" ")} failed: ${output}`, { cause })));
            child.once("close", (code) =>
                code === 0 ? resolve_() : reject(new Error(`CLI ${args.join(" ")} failed: ${output}`)),
            );
        });
    };
    let socket: WebSocket | undefined;
    const stateDirectory =
        launch === "managed" ? (await openMortyInstallation(signal, cliEnvironment)).stateDirectory : directory;
    const encryption = await createEncryptedDaemonFrames(stateDirectory, "real-agent", signal);
    const subscriptions = new Map<string, NativeSessionTarget>();
    let sendTail: Promise<void> = Promise.resolve();
    const send = (message: string | Uint8Array): void => {
        const connection = socket;
        if (connection === undefined) {
            throw new Error("Daemon is not connected");
        }
        sendTail = sendTail.then(async () => {
            signal.throwIfAborted();
            connection.send(await encryption.encode(message));
        });
        void sendTail.catch((error: unknown) => waiter?.reject(error));
    };
    const subscribe = async (target: NativeSessionTarget): Promise<void> => {
        subscriptions.set(JSON.stringify([target.harness, target.sessionId]), target);
        send(JSON.stringify({ kind: "session.events.subscribe", subscriptionId: randomUUID(), target }));
        await sendTail;
    };
    const messages: Array<string | Buffer> = [];
    const recentFrames: string[] = [];
    let waiter: PromiseWithResolvers<string | Buffer> | undefined;
    const stopWaiting = (): void => waiter?.reject(signal.reason);
    signal.addEventListener("abort", stopWaiting, { once: true });
    try {
        await mkdir(workspace, { recursive: true });
        await listen(relay);
        let connected = Promise.withResolvers<void>();
        const abortConnection = (): void => connected.reject(signal.reason);
        signal.addEventListener("abort", abortConnection, { once: true });
        server.on("connection", (connection) => {
            socket = connection;
            connection.on("message", (value, isBinary) => {
                const message = isBinary ? Buffer.from(value as Buffer) : value.toString();
                if (typeof message === "string" && message !== COMPUTER_HEARTBEAT_MESSAGE) {
                    recentFrames.push(message);
                    if (recentFrames.length > 10) {
                        recentFrames.shift();
                    }
                }
                // Like the Relay's host, answer exactly the heartbeat text without the application.
                if (message === COMPUTER_HEARTBEAT_MESSAGE) {
                    connection.send(COMPUTER_HEARTBEAT_ACK_MESSAGE);
                    return;
                }

                if (waiter === undefined) {
                    messages.push(message);
                } else {
                    const pending = waiter;
                    waiter = undefined;
                    pending.resolve(message);
                }
            });
            connection.send(encodeComputerLivenessReadyEvent({ kind: COMPUTER_LIVENESS_READY_KIND }));
            connected.resolve();
        });
        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/real-agent/daemon`);
        // Managed launches perform discovery in the production CLI; only an embedded
        // computer needs a catalog prepared by the fixture.
        const config =
            launch === "embedded"
                ? await (async () => {
                      const inventory = await discoverLocalAgentInventory({
                          dataDirectory: directory,
                          defaultWorkspace: workspace,
                          environment: cliEnvironment,
                          signal,
                          specifications: [specification],
                      });
                      const agent = inventory.readyAgents().find((entry) => entry.harness === specification.harness);
                      if (agent === undefined) {
                          throw new Error(
                              `Real ${specification.label} unavailable: ${JSON.stringify(inventory.unavailable)}`,
                          );
                      }
                      return createRuntimeConfig(
                          {
                              credentials: memoryComputerCredentials("r".repeat(43)),
                              computerId: "real-agent",
                              defaultWorkspace: workspace,
                              relayUrl,
                          },
                          new RuntimeAgentDependencies([agent], adapters),
                          new RuntimeLocalContext(directory, { ...process.env, ...environment }),
                          async (agent) => agent,
                      );
                  })()
                : null;
        if (launch === "managed") {
            const installation = await openMortyInstallation(signal, cliEnvironment);
            await installation.saveConnection(
                {
                    computerId: "real-agent",
                    defaultWorkspace: workspace,
                    relayOrigin: new URL(`http://127.0.0.1:${port(relay)}`),
                    computerCredential: "r".repeat(43),
                },
                signal,
            );
        }
        const start = async (): Promise<void> => {
            if (config === null) {
                await cli(["start"]);
            } else {
                execution = new AbortController();
                runtime = runRuntime(config, AbortSignal.any([signal, execution.signal]), runtimeTimer, {
                    // A scenario that needs process retirement shrinks the retained process budget.
                    processes: new AgentProcessPool(
                        Number(environment["MORTY_TEST_MAX_ACP_PROCESSES"] ?? "1000"),
                        runtimeTimer,
                    ),
                });
                void runtime.catch((error: unknown) => {
                    connected.reject(error);
                    waiter?.reject(error);
                });
            }
        };
        await start();
        try {
            await connected.promise;
        } finally {
            signal.removeEventListener("abort", abortConnection);
        }
        const nextFrame = async (): Promise<string | Buffer> => {
            signal.throwIfAborted();
            await sendTail;
            let message = messages.shift();
            if (message === undefined) {
                waiter = Promise.withResolvers<string | Buffer>();
                message = await waiter.promise;
            }
            const decoded = await encryption.decode(message);
            return typeof decoded === "string" ? decoded : Buffer.from(decoded);
        };
        const nextMessage = async (): Promise<string> => {
            const message = await nextFrame();
            if (typeof message !== "string") {
                throw new Error("Expected a text daemon message");
            }
            return message;
        };
        const pendingEvents: string[] = [];
        await scenario({
            restart: async (mode, restoreFiles) => {
                await sendTail;
                messages.length = 0;
                pendingEvents.length = 0;
                connected = Promise.withResolvers<void>();
                if (launch === "managed") {
                    if (mode === "crash") {
                        const control = await openMortyInstallation(signal, cliEnvironment);
                        const status = decodeLifecycleResponse(
                            await sendLocalRequest(control.stateDirectory, { kind: "status" }, signal),
                        );
                        if (status.kind !== "status") {
                            throw new Error("The managed daemon is unavailable for SIGKILL");
                        }
                        process.kill(status.daemon.pid, "SIGKILL");
                    } else {
                        await cli(["quit"]);
                    }
                } else {
                    execution.abort();
                    await runtime;
                }
                await restoreFiles?.();
                await start();
                await connected.promise;
                for (const target of subscriptions.values()) {
                    await subscribe(target);
                }
            },
            stateDirectory: directory,
            cli: async (args) => await cli(args),
            readDiagnostics: async () => await readFile(join(directory, "logs", "daemon.log"), "utf8"),
            signal,
            workspace,
            send,
            subscribe,
            nextMessage,
            nextFrame,
            nextEvent: async () => {
                const pending = pendingEvents.shift();
                if (pending !== undefined) {
                    return pending;
                }
                for (;;) {
                    const message = await nextMessage();
                    if (decodeMessageKind(message) === "session.event.v2") {
                        pendingEvents.push(
                            ...decodeSessionEventEnvelope(message).events.map((event) => JSON.stringify(event)),
                        );
                        const event = pendingEvents.shift();
                        if (event !== undefined) {
                            return event;
                        }
                    }
                }
            },
        });
    } catch (cause) {
        const diagnostics = await collectLocalDaemonLogs(directory, 100, AbortSignal.timeout(5_000)).catch(
            (cause: unknown) => ({ collectionFailure: inspect(cause) }),
        );
        process.stderr.write(
            `Real ${specification.label} ${launch} scenario failed: ${inspect(cause, { depth: 8 })}\n` +
                `Recent test transport frames:\n${recentFrames.join("\n")}\n` +
                `Daemon diagnostics:\n${inspect(diagnostics, { depth: 8 }).slice(-32_768)}\n`,
        );
        throw cause;
    } finally {
        try {
            if (launch === "managed") {
                await cli(["quit"], AbortSignal.timeout(15_000));
            }
        } finally {
            controller.abort();
            encryption.close();
            signal.removeEventListener("abort", stopWaiting);
            await runtime?.catch(() => {});
            for (const connection of server.clients) {
                connection.terminate();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (relay.listening) {
                await new Promise<void>((resolve) => relay.close(() => resolve()));
            }
            await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
        }
    }
}

/** Waits for the Computer's answer to prompt `commandId`: it was queued, began executing, or settled at once. */
export async function nextPromptAcceptance(peer: DaemonConnectionPeer, commandId: string) {
    for (;;) {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) === "session.operation.failed") {
            throw new Error(message);
        }
        if (decodeMessageKind(message) === "session.prompt.accepted") {
            const accepted = decodeSessionPromptAcceptedEvent(message);
            if (accepted.requestId === commandId) {
                return accepted;
            }
        }
    }
}

/** Waits for the lifecycle event that settles prompt `commandId`; the Session is idle again once it arrives. */
export async function nextPromptSettlement(peer: DaemonConnectionPeer, commandId: string) {
    for (;;) {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) !== SESSION_EVENT_KIND) {
            continue;
        }
        for (const event of decodeSessionEventEnvelope(message).events) {
            if (
                event.type === "lifecycle-metadata" &&
                isPromptTerminal(event.payload) &&
                event.payload.commandId === commandId
            ) {
                return event.payload;
            }
        }
    }
}

/** Opens an Agent-owned conversation through the same discovery and import boundary as the browser. */
export async function importRealSession(
    peer: DaemonConnectionPeer,
    harness: string,
    sessionId: string,
): Promise<NativeSessionTarget> {
    const identity = {
        kind: "native.session.request",
        harness,
        directory: ".",
    } as const;
    const receive = async (requestId: string) => {
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind === "native.session.result") {
                const result = decodeNativeSessionResult(message);
                if (result.requestId === requestId) {
                    return result;
                }
            }
        }
    };
    const findId = randomUUID();
    peer.send(encodeNativeSessionCommand({ ...identity, action: "find", requestId: findId, sessionId }));
    const found = await receive(findId);
    if (found.action !== "find") {
        throw new Error("Expected a native Session discovery");
    }
    const importId = randomUUID();
    peer.send(
        encodeNativeSessionCommand({
            ...identity,
            directory: found.entry.directory,
            action: "import",
            sessionId: found.entry.sessionId,
            requestId: importId,
        }),
    );
    const imported = await receive(importId);
    if (imported.action !== "import") {
        throw new Error("Expected a native Session import");
    }
    await peer.subscribe(imported.target);
    return imported.target;
}

/** Opens a conversation through first-send creation; only the harness chooses its native ID. */
export async function prepareNewRealSession(peer: DaemonConnectionPeer, harness: string): Promise<NativeSessionTarget> {
    const requestId = randomUUID();
    peer.send(
        encodeSessionCreateCommand({
            kind: "session.create",
            requestId,
            operationId: randomUUID(),
            configurations: [],
            harness,
            directory: ".",
        }),
    );
    for (;;) {
        peer.signal.throwIfAborted();
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind === "session.ready") {
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId === requestId) {
                await peer.subscribe(ready.target);
                return ready.target;
            }
        }
    }
}
