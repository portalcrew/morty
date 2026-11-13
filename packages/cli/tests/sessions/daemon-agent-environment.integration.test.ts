import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    AGENT_SETTINGS_DISCOVER_KIND,
    AGENT_SETTINGS_DISCOVERED_KIND,
    decodeMessageKind,
    encodeAgentSettingsDiscoverCommand,
    MORTY_API_PREFIX,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { RuntimeLocalContext } from "../../src/engine/runtime/config.ts";
import { runRuntime } from "../../src/engine/runtime/run.ts";
import { ControlledAcpConnection } from "../support/agents/controlled-acp-connection.ts";
import { createControlledAgent } from "../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../support/computer-credentials.ts";
import { createControlledRuntimeConfig } from "../support/controlled-runtime-config.ts";
import { createEncryptedDaemonGateway, type EncryptedDaemonPeer } from "../support/encrypted-daemon-gateway.ts";

const recorderPath = fileURLToPath(new URL("./fixtures/acp-environment-recorder.ts", import.meta.url));

async function nextMessageOfKind(socket: EncryptedDaemonPeer, kind: string): Promise<void> {
    while (decodeMessageKind(await socket.next()) !== kind) {
        // Read the real daemon until its correlated result arrives.
    }
}

/** Starts a daemon whose Computer keeps its data in an installation directory, launches its Agent, and reads what the Agent inherited. */
async function inheritedStateDirectory(daemonEnvironment: NodeJS.ProcessEnv): Promise<unknown> {
    const directory = await mkdtemp(join(tmpdir(), "morty-agent-environment-"));
    const installationData = join(
        directory,
        "root",
        "versions",
        "0.0.0",
        "installations",
        "build.morty.cli",
        "min_test",
    );
    const workspace = join(directory, "workspace");
    const record = join(directory, "agent-environment.json");
    await Promise.all([mkdir(installationData, { recursive: true }), mkdir(workspace)]);

    const gateway = await createEncryptedDaemonGateway(
        installationData,
        "channel_environment",
        AbortSignal.timeout(60_000),
    );
    const socketReady = Promise.withResolvers<EncryptedDaemonPeer>();
    const relay = createServer((request, response) => {
        request.resume();
        response.writeHead(request.method === "PUT" ? 204 : 404);
        response.end();
    });
    const sockets = new WebSocketServer({ server: relay });
    sockets.on("connection", (socket) => socketReady.resolve(gateway.connect(socket)));
    await listen(relay);
    const relayUrl = new URL(`ws://127.0.0.1:${port(relay)}${MORTY_API_PREFIX}/channels/channel_environment/daemon`);

    const agent = createControlledAgent(
        (options) =>
            new ControlledAcpConnection(
                {
                    harness: "controlled-acp",
                    adapterPath: process.execPath,
                    arguments: [recorderPath],
                    environment: options.environment,
                },
                options,
            ),
        "controlled-acp",
        "Controlled ACP",
        process.execPath,
        {
            MORTY_FAKE_ACP_STATE_DIRECTORY: join(directory, "native"),
            MORTY_TEST_ENVIRONMENT_RECORD: record,
        },
    );
    const config = createControlledRuntimeConfig(
        {
            credentials: memoryComputerCredentials("r".repeat(43)),
            computerId: "channel_environment",
            defaultWorkspace: workspace,
            relayUrl,
        },
        [agent],
        // As the worker does: the Computer's local data is this installation's directory.
        new RuntimeLocalContext(installationData, daemonEnvironment),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await socketReady.promise;
        const discovered = nextMessageOfKind(socket, AGENT_SETTINGS_DISCOVERED_KIND);
        await socket.send(
            encodeAgentSettingsDiscoverCommand({
                harness: agent.harness,
                kind: AGENT_SETTINGS_DISCOVER_KIND,
                requestId: "environment-discovery",
            }),
        );
        await discovered;
        const recorded: unknown = JSON.parse(await readFile(record, "utf8"));
        return recorded;
    } finally {
        cancellation.abort();
        await runtime;
        await gateway.close();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(directory, { force: true, recursive: true });
    }
}

test("Given a daemon started with a custom state root, When it launches an Agent, Then the Agent inherits that root rather than the Computer's installation data", {
    timeout: 60_000,
}, async () => {
    const root = join(tmpdir(), "morty-custom-root");
    const environment = { ...process.env, MORTY_STATE_DIRECTORY: root };

    expect(await inheritedStateDirectory(environment)).toEqual({ stateDirectory: root });
});

test("Given a daemon started with the default state root, When it launches an Agent, Then the Agent's environment leaves the root unset so Morty there uses the same default", {
    timeout: 60_000,
}, async () => {
    const environment = { ...process.env };
    delete environment["MORTY_STATE_DIRECTORY"];

    expect(await inheritedStateDirectory(environment)).toEqual({ stateDirectory: null });
});
