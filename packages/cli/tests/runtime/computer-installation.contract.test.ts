import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    COMPUTER_LIVENESS_READY_KIND,
    COMPUTER_SUCCESSOR_CREDENTIAL_HEADER,
    encodeComputerLivenessReadyEvent,
} from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RuntimeInstallationStore } from "../../src/engine/runtime/connection/runtime-installation-store.ts";
import { TestComputerHost } from "../support/computer-host.ts";

it("Given an explicit data directory, When a host saves a connection and reopens its store, Then saved connections survive", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-api-"));
    const params = { dataDirectory: join(directory, "data"), agentLaunchEnvironment: { PATH: "" } };
    try {
        const store = await RuntimeInstallationStore.open(params.dataDirectory, signal);
        const connection = await store.saveConnection(
            {
                computerId: "embedded_channel",
                defaultWorkspace: join(directory, "workspace"),
                relayOrigin: new URL("https://relay.example.com/"),
                computerCredential: "a".repeat(43),
            },
            signal,
        );
        const reopened = await RuntimeInstallationStore.open(params.dataDirectory, signal);
        expect(await reopened.readConnection(connection.pairingGeneration, signal)).toEqual(connection);
        expect(await reopened.currentConnection(signal)).toEqual(connection);
        await reopened.recordRevocation(connection.pairingGeneration, signal);
        expect(await store.readConnection(connection.pairingGeneration, signal)).toMatchObject({ revoked: true });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given a fresh installation, When a host concurrently saves connections, Then only one complete pairing becomes active", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-concurrent-"));
    try {
        const manager = await RuntimeInstallationStore.open(directory, signal);
        const results = await Promise.allSettled(
            Array.from({ length: 32 }, (_, index) =>
                manager.saveConnection(
                    {
                        computerId: `concurrent_channel_${index}`,
                        defaultWorkspace: join(directory, "workspace"),
                        relayOrigin: new URL("https://relay.example.com/"),
                        computerCredential: "a".repeat(43),
                    },
                    signal,
                ),
            ),
        );
        const saved = await manager.currentConnection(signal);
        expect(
            results.some(
                (result) =>
                    result.status === "fulfilled" && result.value.pairingGeneration === saved?.pairingGeneration,
            ),
        ).toBe(true);
        for (const result of results) {
            if (result.status === "rejected") {
                expect(result.reason).toMatchObject({ code: "pairing_busy" });
            }
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given a saved connection with an opaque credential, When a host serves and cancels its loop, Then it publishes its Agent directory, disconnects before completion, and presents its saved successor next time", async ({
    signal,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "morty-engine-loop-"));
    const catalogs: unknown[] = [];
    const requests: string[] = [];
    const authorizations: (string | undefined)[] = [];
    const successors: (string | undefined)[] = [];
    const http = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            body += chunk;
        });
        request.on("end", () => {
            catalogs.push(JSON.parse(body));
            response.writeHead(204).end();
        });
    });
    const relay = new WebSocketServer({ server: http });
    let disconnected = Promise.withResolvers<void>();
    let revoke = false;
    relay.on("connection", (socket, request) => {
        requests.push(request.url ?? "");
        authorizations.push(request.headers.authorization);
        const successor = request.headers[COMPUTER_SUCCESSOR_CREDENTIAL_HEADER];
        successors.push(typeof successor === "string" ? successor : undefined);
        socket.once("close", () => disconnected.resolve());
        if (revoke) {
            socket.close(1008, "Computer revoked");
            return;
        }
        socket.send(encodeComputerLivenessReadyEvent({ kind: COMPUTER_LIVENESS_READY_KIND }));
        socket.on("message", (encoded) => {
            if (encoded.toString() === COMPUTER_HEARTBEAT_MESSAGE) {
                socket.send(COMPUTER_HEARTBEAT_ACK_MESSAGE);
            }
        });
    });
    await listen(http);
    try {
        const origin = `http://127.0.0.1:${port(http)}`;
        const engine = new TestComputerHost({
            dataDirectory: join(directory, "data"),
            agentLaunchEnvironment: {
                PATH: "",
                MORTY_CLAUDE_PATH: "",
                MORTY_CODEX_PATH: "",
                MORTY_PI_PATH: "",
            },
        });
        const manager = await RuntimeInstallationStore.open(join(directory, "data"), signal);
        const saved = await manager.saveConnection(
            {
                computerId: "loop_channel",
                defaultWorkspace: join(directory, "workspace"),
                relayOrigin: new URL(origin),
                computerCredential: "a".repeat(73),
            },
            signal,
        );
        const shutdown = new AbortController();
        let online = false;
        await engine.runLoop({
            pairingGeneration: saved.pairingGeneration,
            signal: AbortSignal.any([signal, shutdown.signal]),
            onConnectionStatus: (status) => {
                if (status === "online") {
                    online = true;
                    shutdown.abort();
                }
            },
        });
        await disconnected.promise;
        expect(online).toBe(true);
        expect(requests).toHaveLength(1);
        expect(authorizations).toEqual([`Bearer ${"a".repeat(73)}`]);
        expect(catalogs).toHaveLength(1);
        expect(catalogs).toEqual([expect.objectContaining({ agents: [] })]);
        const [savedSuccessor] = successors;
        expect(savedSuccessor).toMatch(/^[A-Za-z0-9_-]{73}$/u);
        expect(await manager.currentConnection(signal)).toEqual({
            ...saved,
            credentials: { current: savedSuccessor, successor: null },
        });

        disconnected = Promise.withResolvers<void>();
        revoke = true;
        await expect(engine.runLoop({ pairingGeneration: saved.pairingGeneration, signal })).rejects.toMatchObject({
            code: "computer_relay_revoked",
        });
        await disconnected.promise;
        expect(authorizations.at(-1)).toBe(`Bearer ${savedSuccessor}`);
    } finally {
        for (const socket of relay.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => relay.close(() => http.close(() => resolve())));
        await rm(directory, { recursive: true, force: true });
    }
});
