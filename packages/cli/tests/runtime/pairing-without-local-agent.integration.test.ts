import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { describe, expect, it } from "vitest";
import { RuntimeInstallationStore } from "../../src/engine/runtime/connection/runtime-installation-store.ts";

interface PairingRelay {
    readonly claims: Array<Readonly<Record<string, unknown>>>;
    readonly dispose: () => Promise<void>;
    readonly origin: string;
}

/**
 * Accepts the pairing redemption and records the Agent directory the computer advertised. Only the
 * Agent inventory is under test; the redemption response is the Relay's own contract.
 */
async function createPairingRelay(): Promise<PairingRelay> {
    const claims: Array<Readonly<Record<string, unknown>>> = [];
    const sockets = new Set<Socket>();
    const server: Server = createServer((request, response) => {
        // A daemon the CLI reloads after pairing also dials the Relay; only redemptions are answered.
        if (request.method !== "POST" || request.url?.endsWith("/redeem") !== true) {
            response.writeHead(404).end();
            return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("end", () => {
            claims.push(JSON.parse(body) as Readonly<Record<string, unknown>>);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    computerId: "unattended-computer",
                    computerCredential: "u".repeat(32),
                }),
            );
        });
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    await listen(server);
    return {
        claims,
        dispose: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error === undefined) {
                        resolve();
                        return;
                    }
                    reject(error);
                });
            });
        },
        origin: `http://127.0.0.1:${port(server)}`,
    };
}

// Empty overrides short-circuit discovery for every supported Agent, so no computer installation
// can satisfy the pairing. This keeps the scenario independent of what the developer has on PATH.
function agentlessEnvironment(stateDirectory: string): Readonly<NodeJS.ProcessEnv> {
    return Object.freeze({
        MORTY_CLAUDE_PATH: "",
        MORTY_CODEX_PATH: "",
        MORTY_PI_PATH: "",
        MORTY_STATE_DIRECTORY: stateDirectory,
        PATH: "",
    });
}

/** Runs the built CLI with `input` piped to its standard input. */
describe("pairing a computer without a local Agent", () => {
    it("Given no supported Agent is discoverable, When the computer redeems its pairing, Then it pairs and advertises an empty Agent directory", async ({
        signal,
    }) => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-unattended-computer-"));
        const relay = await createPairingRelay();

        try {
            const { TestComputerHost } = await import("../support/computer-host.ts");
            const engine = new TestComputerHost({
                dataDirectory: stateDirectory,
                agentLaunchEnvironment: agentlessEnvironment(stateDirectory),
            });

            const paired = await engine.pair(
                {
                    defaultWorkspace: join(stateDirectory, "workspace"),
                    pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
                    computerId: "unattended-computer",
                    relayOrigin: relay.origin,
                },
                signal,
            );

            expect(
                await (await RuntimeInstallationStore.open(stateDirectory, signal)).readConnection(
                    paired.pairingGeneration,
                    signal,
                ),
            ).toMatchObject({
                computerId: "unattended-computer",
            });
            expect(relay.claims).toHaveLength(1);
            expect(relay.claims[0]).toMatchObject({
                agents: [],
                pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
            });
        } finally {
            await relay.dispose();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given an unattended computer is already paired, When another Engine reads its saved connection, Then pairing is retained without redeeming again", async ({
        signal,
    }) => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-unattended-resume-"));
        const relay = await createPairingRelay();
        const environment = agentlessEnvironment(stateDirectory);

        try {
            const { TestComputerHost } = await import("../support/computer-host.ts");
            const engine = new TestComputerHost({
                dataDirectory: stateDirectory,
                agentLaunchEnvironment: environment,
            });
            const paired = await engine.pair(
                {
                    defaultWorkspace: join(stateDirectory, "workspace"),
                    pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
                    computerId: "unattended-computer",
                    relayOrigin: relay.origin,
                },
                signal,
            );

            const resumed = await (await RuntimeInstallationStore.open(stateDirectory, signal)).readConnection(
                paired.pairingGeneration,
                signal,
            );

            expect(resumed.pairingGeneration).toBe(paired.pairingGeneration);
            expect(resumed).toEqual(paired);
            expect(relay.claims).toHaveLength(1);
        } finally {
            await relay.dispose();
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });
});
