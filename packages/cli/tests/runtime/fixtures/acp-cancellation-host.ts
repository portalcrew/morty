import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { agent as acpAgent, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import { AGENT_SETTINGS_DISCOVERED_KIND, encodeAgentSettingsDiscoverCommand } from "@morty-build/client/protocol";
import { type ControlledAcpPeer, ControlledEndpointConnection } from "@morty-build/runtime-test-support/fake-daemon";
import { WebSocketServer } from "ws";
import { RuntimeLocalContext } from "../../../src/engine/runtime/config.ts";
import { runRuntime } from "../../../src/engine/runtime/run.ts";
import { createControlledAgent } from "../../support/agents/controlled-agent-definition.ts";
import { memoryComputerCredentials } from "../../support/computer-credentials.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../../support/controlled-runtime-config.ts";
import { createEncryptedDaemonGateway } from "../../support/encrypted-daemon-gateway.ts";

// External Agent failure modes: cancellation before its initialization promise is
// observed, cancellation while initialization is pending, and ordinary startup failure.
// A process-level fatal handler exits the host on an unhandled rejection.
process.on("unhandledRejection", (error: unknown) => {
    process.stderr.write(`unhandled_rejection: ${String(error)}\n`);
    process.exit(91);
});

const [directory, cancellation] = process.argv.slice(2);
if (directory === undefined || cancellation === undefined) {
    throw new Error("Missing fixture arguments");
}
const controller = new AbortController();
const reason = new Error("The Computer owner cancelled initialization");
let cancelled = false;
let endpointClosed = false;
const http = createServer((request, response) => {
    request.resume();
    response.writeHead(request.method === "PUT" ? 204 : 404).end();
});
const relay = new WebSocketServer({ server: http });
const settings = Promise.withResolvers<void>();
const app = acpAgent({ name: "cancellation-peer" })
    .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        agentInfo: { name: "cancellation-peer", version: "1.0.0" },
        authMethods: [],
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "settings-session", configOptions: [] }));

const endpoint = (): ControlledAcpPeer => {
    const initialized = Promise.withResolvers<void>();
    const terminated = Promise.withResolvers<{ readonly kind: "closed" }>();
    let pending = false;
    return {
        app: () => app,
        terminated: terminated.promise,
        initialize: () => {
            if (cancelled) {
                return Promise.resolve();
            }
            pending = true;
            cancelled = true;
            process.stdout.write("external-agent-initializing\n");
            if (cancellation === "before-observation") {
                controller.abort(reason);
            } else {
                setImmediate(() => controller.abort(reason));
            }
            return initialized.promise;
        },
        close: async () => {
            endpointClosed = true;
            if (pending) {
                initialized.reject(new Error("ACP connection closed"));
            }
            terminated.resolve({ kind: "closed" });
        },
    };
};

const gateway = await createEncryptedDaemonGateway(directory, "cancellation-test", AbortSignal.timeout(60_000));
relay.on("connection", (socket) => {
    const peer = gateway.connect(socket);
    void peer.send(
        encodeAgentSettingsDiscoverCommand({
            kind: "agent.settings.discover",
            harness: "cancellation-peer",
            requestId: cancelled ? "healthy-settings" : "cancelled-settings",
        }),
    );
    void (async () => {
        for (;;) {
            if (JSON.parse(await peer.next()).kind === AGENT_SETTINGS_DISCOVERED_KIND) {
                settings.resolve();
                return;
            }
        }
    })().catch(() => undefined);
});

await mkdir(join(directory, "workspace"), { recursive: true });
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const address = http.address();
if (address === null || typeof address === "string") {
    throw new Error("Relay did not bind");
}
const config = createRuntimeConfig(
    {
        computerId: "cancellation-test",
        defaultWorkspace: join(directory, "workspace"),
        relayUrl: new URL(`ws://127.0.0.1:${address.port}/daemon`),
        credentials: memoryComputerCredentials("r".repeat(43)),
    },
    [
        createControlledAgent(
            (options) => new ControlledEndpointConnection(endpoint(), options.client),
            "cancellation-peer",
            "Cancellation peer",
            process.execPath,
        ),
    ],
    new RuntimeLocalContext(directory, { PATH: process.env["PATH"] }),
    async (agent) => agent,
);
try {
    await runRuntime(config, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!endpointClosed) {
        throw new Error("The cancelled endpoint was not closed");
    }
    process.stdout.write("cancelled-request-settled\n");
    const healthy = new AbortController();
    const runtime = runRuntime(config, healthy.signal);
    try {
        await settings.promise;
        process.stdout.write("subsequent-settings-succeeded\n");
    } finally {
        healthy.abort();
        await runtime;
    }
} finally {
    await gateway.close();
    for (const client of relay.clients) {
        client.terminate();
    }
    await new Promise<void>((resolve) => relay.close(() => http.close(() => resolve())));
}
