import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    decodeAgentSettingsDiscoveredEvent,
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionOperationFailedEvent,
    decodeSessionPreviewHistoryPageLoaded,
    decodeSessionReadyEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeNativeSessionCommand,
    encodeSessionCreateCommand,
    encodeSessionPreviewHistoryPageLoad,
    MORTY_API_PREFIX,
    NATIVE_SESSION_REQUEST_KIND,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import { discoverLocalAgentInventory } from "../../src/engine/agent/discovery/discover-local-agents.ts";
import type { LocalAgentSpecification } from "../../src/engine/agent/specification/agent-specification.ts";
import { publishAgentCatalog } from "../../src/engine/runtime/catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "../../src/engine/runtime/catalog/resolve-catalog-agent.ts";
import { createRuntimeConfig, RuntimeAgentDependencies, RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createEncryptedDaemonGateway, type EncryptedDaemonPeer } from "../support/encrypted-daemon-gateway.ts";

const sendText = (peer: EncryptedDaemonPeer, message: string) => peer.send(message);
const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

class RefreshableAgentSpecification extends ControlledAcpSpecification {
    readonly agentExecutable = "controlled-acp";
    readonly harness: string;
    readonly label = "Controlled ACP";
    override readonly minimumSupportedAgentVersion = "1.0.0";

    constructor(id: string) {
        super("MORTY_TEST_REFRESHABLE_AGENT_PATH", []);
        this.harness = id;
    }
}

// A second ready Agent whose executable never changes, so a refresh of the upgraded Agent must
// keep exactly one catalog entry for it.
class UnchangedPeerAgentSpecification extends ControlledAcpSpecification {
    readonly agentExecutable = "controlled-acp-peer";
    readonly harness = "controlled-acp-peer";
    readonly label = "Controlled ACP Peer";

    constructor() {
        super("MORTY_TEST_PEER_PATH", ["--profile", "acp"]);
    }
}

function specifications(harness: string): readonly LocalAgentSpecification[] {
    return [new RefreshableAgentSpecification(harness), new UnchangedPeerAgentSpecification()];
}

function launcherSource(version: string, peerUrl: string, nativeSessions = true): string {
    return `#!${process.execPath}
const version = ${JSON.stringify(version)};
if (process.argv.includes("--version")) {
    process.stdout.write(version + "\\n");
    process.exit(0);
}
if (process.argv.includes("app-server")) {
    const threads = new Set();
    const { createInterface } = await import("node:readline");
    const input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        if (message.method === "initialize") {
            process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
        } else if (message.method === "thread/start") {
            const id = crypto.randomUUID();
            threads.add(id);
            process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id } } }) + "\\n");
        } else if (message.method === "model/list" || message.method === "thread/list") {
            process.stdout.write(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }) + "\\n");
        } else if (message.method === "thread/settings/update" && threads.has(message.params.threadId)) {
            process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
        } else if (message.method === "thread/turns/list") {
            const result = {
                data: [{
                    id: "saved-turn", status: "completed",
                    items: [{ id: "saved-answer", type: "agentMessage", text: "History from " + version }],
                }],
                nextCursor: null,
            };
            process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
        } else {
            process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported method" } }) + "\\n");
        }
    });
    await new Promise((resolve) => input.on("close", resolve));
    process.exit(0);
}
process.argv.push(
    "--agent-name", "Controlled ACP",
    "--agent-version", version,
    "--no-load-session",
    "--http-mcp",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
);
if (!${JSON.stringify(nativeSessions)}) process.argv.push("--no-native-sessions");
await import(${JSON.stringify(peerUrl)});
`;
}

type PrepareOutcome =
    | {
          readonly kind: "session.operation.failed";
          readonly failure: ReturnType<typeof decodeSessionOperationFailedEvent>;
      }
    | { readonly kind: "session.ready"; readonly ready: ReturnType<typeof decodeSessionReadyEvent> }
    | { readonly kind: "native.session.result"; readonly result: ReturnType<typeof decodeNativeSessionResult> }
    | {
          readonly kind: "session.preview-history.page.loaded";
          readonly preview: ReturnType<typeof decodeSessionPreviewHistoryPageLoaded>;
      }
    | {
          readonly kind: typeof AGENT_SETTINGS_DISCOVERED_KIND;
          readonly discovered: ReturnType<typeof decodeAgentSettingsDiscoveredEvent>;
      };

async function nextCommandOutcome(frames: EncryptedDaemonPeer, requestId: string): Promise<PrepareOutcome> {
    for (;;) {
        const message = await frames.next();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            const failure = decodeSessionOperationFailedEvent(message);
            if (failure.requestId === requestId) {
                return { kind, failure };
            }
        }
        if (kind === "session.ready") {
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId === requestId) {
                return { kind, ready };
            }
        }
        if (kind === AGENT_SETTINGS_DISCOVERED_KIND) {
            const discovered = decodeAgentSettingsDiscoveredEvent(message);
            if (discovered.requestId === requestId) {
                return { kind, discovered };
            }
        }
        if (kind === "native.session.result") {
            const result = decodeNativeSessionResult(message);
            if (result.requestId === requestId) {
                return { kind, result };
            }
        }
        if (kind === "session.preview-history.page.loaded") {
            const preview = decodeSessionPreviewHistoryPageLoaded(message);
            if (preview.requestId === requestId) {
                return { kind, preview };
            }
        }
    }
}

test.for([
    { harness: "controlled-acp", queryBeforeUpgrade: false },
    { harness: "controlled-acp", queryBeforeUpgrade: true },
    { harness: "codex", queryBeforeUpgrade: false },
])(
    "Given a $harness conversation and retained reader=$queryBeforeUpgrade before an upgrade, When preparation and native history are requested, Then both use the upgraded Agent without restarting",
    {
        timeout: 120_000,
    },
    async ({ harness, queryBeforeUpgrade }) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-daemon-agent-refresh-"));
        const workspace = join(stateDirectory, "workspace");
        const nativeStateDirectory = join(stateDirectory, "native");
        const binDirectory = join(stateDirectory, "bin");
        const firstLauncher = join(stateDirectory, "controlled-acp-v1");
        const secondLauncher = join(stateDirectory, "controlled-acp-v2");
        const link = join(binDirectory, "controlled-acp");
        const peerLauncher = join(stateDirectory, "controlled-acp-peer");
        await Promise.all([mkdir(workspace), mkdir(nativeStateDirectory), mkdir(binDirectory)]);
        await writeFile(
            firstLauncher,
            launcherSource("1.0.0", new URL(`file://${fakeAgentPath}`).toString(), !queryBeforeUpgrade),
            {
                mode: 0o700,
            },
        );
        await writeFile(secondLauncher, launcherSource("1.1.0", new URL(`file://${fakeAgentPath}`).toString()), {
            mode: 0o700,
        });
        await writeFile(peerLauncher, launcherSource("1.0.0", new URL(`file://${fakeAgentPath}`).toString()), {
            mode: 0o700,
        });
        await symlink(firstLauncher, link);
        await symlink(peerLauncher, join(binDirectory, "controlled-acp-peer"));

        const catalogBodies: string[] = [];
        const gateway = await createEncryptedDaemonGateway(
            stateDirectory,
            "channel_alpha",
            AbortSignal.timeout(120_000),
        );
        const socketReady = Promise.withResolvers<EncryptedDaemonPeer>();
        const relay = createServer((request, response) => {
            if (request.method === "PUT" && request.url?.includes("/catalog") === true) {
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                    catalogBodies.push(Buffer.concat(chunks).toString("utf8"));
                    response.writeHead(204);
                    response.end();
                });
                return;
            }
            response.writeHead(404);
            response.end();
        });
        const sockets = new WebSocketServer({ server: relay });
        sockets.on("connection", (socket) => socketReady.resolve(gateway.connect(socket)));
        await listen(relay);

        const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/channel_alpha/daemon`);
        const environment = {
            MORTY_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory,
            PATH: `${binDirectory}:${process.env["PATH"] ?? ""}`,
        };
        const inventory = await discoverLocalAgentInventory({
            dataDirectory: stateDirectory,
            defaultWorkspace: workspace,
            environment,
            signal: AbortSignal.timeout(60_000),
            specifications: specifications(harness),
        });
        const agent = inventory.readyAgents().find((entry) => entry.harness === harness);
        if (agent === undefined || inventory.readyAgents().length !== 2) {
            await rm(stateDirectory, { force: true, recursive: true });
            throw new Error(`Controlled agent was not discovered: ${JSON.stringify(inventory.unavailable)}`);
        }
        const config: ReturnType<typeof createRuntimeConfig> = createRuntimeConfig(
            {
                credentials: memoryComputerCredentials("r".repeat(43)),
                computerId: "channel_alpha",
                defaultWorkspace: workspace,
                relayUrl,
            },
            harness === "codex"
                ? new RuntimeAgentDependencies(inventory.readyAgents())
                : new RuntimeAgentDependencies(inventory.readyAgents(), acpAdapters),
            new RuntimeLocalContext(stateDirectory, environment),
            createCatalogAgentResolver(
                (refreshSignal) =>
                    discoverLocalAgentInventory({
                        dataDirectory: stateDirectory,
                        defaultWorkspace: workspace,
                        environment,
                        signal: refreshSignal,
                        specifications: specifications(harness),
                    }),
                () => config,
                publishAgentCatalog,
            ),
        );
        const cancellation = new AbortController();
        const runtime = runRuntime(config, cancellation.signal);

        try {
            const frames = await socketReady.promise;
            await sendText(
                await socketReady.promise,
                encodeSessionCreateCommand({
                    harness,
                    directory: ".",
                    kind: "session.create",
                    requestId: "prepare-before-agent-upgrade",
                    operationId: crypto.randomUUID(),
                    configurations: [],
                }),
            );
            expect(await nextCommandOutcome(frames, "prepare-before-agent-upgrade")).toMatchObject({
                kind: "session.ready",
                ready: { agentVersion: "1.0.0" },
            });
            if (queryBeforeUpgrade) {
                await sendText(
                    await socketReady.promise,
                    encodeNativeSessionCommand({
                        harness,
                        directory: ".",
                        kind: NATIVE_SESSION_REQUEST_KIND,
                        requestId: "browse-before-agent-upgrade",
                        action: "list",
                        cursor: null,
                    }),
                );
                expect(await nextCommandOutcome(frames, "browse-before-agent-upgrade")).toMatchObject({
                    kind: "session.operation.failed",
                    failure: { code: "native_session_unsupported" },
                });
            }
            const prepareRequestId = "prepare-after-agent-upgrade";
            await unlink(link);
            await symlink(secondLauncher, link);

            await sendText(
                await socketReady.promise,
                encodeSessionCreateCommand({
                    harness,
                    directory: ".",
                    kind: "session.create",
                    requestId: prepareRequestId,
                    operationId: crypto.randomUUID(),
                    configurations: [],
                }),
            );
            const prepared = await nextCommandOutcome(frames, prepareRequestId);
            expect(prepared.kind === "session.operation.failed" ? prepared.failure.code : prepared.kind).toBe(
                "session.ready",
            );
            expect(prepared).toMatchObject({
                kind: "session.ready",
                ready: { agentVersion: "1.1.0", target: { harness: harness, sessionId: expect.any(String) } },
            });

            const settingsRequestId = "settings-after-agent-upgrade";
            await sendText(
                await socketReady.promise,
                encodeAgentSettingsDiscoverCommand({
                    harness,
                    kind: AGENT_SETTINGS_DISCOVER_KIND,
                    requestId: settingsRequestId,
                }),
            );
            const discovered = await nextCommandOutcome(frames, settingsRequestId);
            expect(discovered).toMatchObject({
                kind: AGENT_SETTINGS_DISCOVERED_KIND,
                discovered: { agentVersion: "1.1.0" },
            });

            await sendText(
                await socketReady.promise,
                encodeNativeSessionCommand({
                    harness,
                    directory: ".",
                    kind: NATIVE_SESSION_REQUEST_KIND,
                    requestId: "browse-after-agent-upgrade",
                    action: "list",
                    cursor: null,
                }),
            );
            expect(await nextCommandOutcome(frames, "browse-after-agent-upgrade")).toMatchObject({
                kind: "native.session.result",
                result: { action: "list", capabilities: { listSessions: true }, entries: [], nextCursor: null },
            });

            if (harness === "codex") {
                await sendText(
                    await socketReady.promise,
                    encodeSessionPreviewHistoryPageLoad({
                        directory: ".",
                        kind: "session.preview-history.page.load",
                        requestId: "preview-after-agent-upgrade",
                        target: { harness: harness, sessionId: "saved-thread" },
                        eventLimit: 100,
                        cursor: null,
                    }),
                );
                const previewed = await nextCommandOutcome(frames, "preview-after-agent-upgrade");
                expect(previewed.kind).toBe("session.preview-history.page.loaded");
                if (previewed.kind === "session.preview-history.page.loaded") {
                    expect(previewed.preview.events.events.events).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                type: "acp",
                                payload: expect.objectContaining({
                                    sessionUpdate: "agent_message_chunk",
                                    content: { type: "text", text: "History from 1.1.0" },
                                }),
                            }),
                        ]),
                    );
                }
            }

            const republished = catalogBodies
                .map((body) => JSON.parse(body) as { agents: { agentVersion: string; harness: string }[] })
                .filter((catalog) => catalog.agents.some((entry) => entry.agentVersion === "1.1.0"));
            expect(republished).toHaveLength(1);
            expect(republished[0]?.agents.map((entry) => entry.harness).sort()).toEqual(
                [harness, "controlled-acp-peer"].sort(),
            );
        } finally {
            cancellation.abort();
            await runtime.catch(() => {});
            await gateway.close();
            await new Promise<void>((resolve) => sockets.close(() => resolve()));
            await new Promise<void>((resolve) => relay.close(() => resolve()));
            await rm(stateDirectory, { force: true, recursive: true });
            vi.useRealTimers();
        }
    },
);
