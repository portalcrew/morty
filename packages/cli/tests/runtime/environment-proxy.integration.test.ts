import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MORTY_API_PREFIX } from "@morty-build/client/protocol";
import { listen, port } from "@morty-build/relay-test-support/websocket";
import { describe, expect, it } from "vitest";
import { RuntimeInstallationStore } from "../../src/engine/runtime/connection/runtime-installation-store.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function trackConnections(server: Server, sockets: Set<Socket>): void {
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
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
}

describe("daemon environment proxy", () => {
    it("Given proxy environment variables, When pairing and opening the relay, Then both connections use the proxy", async () => {
        await using codex = await ControlledCodexFixture.create();
        const pairingSockets = new Set<Socket>();
        const relaySockets = new Set<Socket>();
        const proxySockets = new Set<Socket>();
        const tunnelTargets: string[] = [];
        const stateDirectory = await mkdtemp(join(tmpdir(), "morty-proxy-test-"));

        const pairingPaths: string[] = [];
        const pairingServer = createServer((request, response) => {
            pairingPaths.push(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    computerId: "proxy-computer",
                    computerCredential: "a".repeat(32),
                }),
            );
        });
        trackConnections(pairingServer, pairingSockets);

        const relayServer = createServer((_request, response) => {
            response.writeHead(426);
            response.end();
        });
        relayServer.on("upgrade", (request, socket) => {
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
        });
        trackConnections(relayServer, relaySockets);

        const proxyServer = createServer((request, response) => {
            const destination = new URL(request.url ?? "/", "http://127.0.0.1");
            const target = new URL(`http://127.0.0.1:${port(pairingServer)}`);
            if (destination.origin !== target.origin) {
                response.writeHead(403).end();
                return;
            }
            tunnelTargets.push(destination.host);
            const headers = { ...request.headers };
            delete headers["proxy-authorization"];
            const upstream = httpRequest(
                target,
                {
                    path: destination.pathname + destination.search,
                    method: request.method,
                    headers,
                    signal: AbortSignal.timeout(2_000),
                },
                (incoming) => {
                    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
                    incoming.pipe(response);
                },
            );
            upstream.once("error", () => response.destroy());
            response.once("close", () => upstream.destroy());
            request.pipe(upstream);
        });
        proxyServer.on("connect", (request, downstream, head) => {
            const encodedTarget = request.url;
            if (encodedTarget === undefined) {
                downstream.destroy();
                return;
            }
            const destinationPort = [port(pairingServer), port(relayServer)].find(
                (candidate) => encodedTarget === `127.0.0.1:${candidate}`,
            );
            if (destinationPort === undefined) {
                downstream.destroy();
                return;
            }
            tunnelTargets.push(encodedTarget);
            const upstream = connect(destinationPort, "127.0.0.1", () => {
                downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.byteLength > 0) {
                    upstream.write(head);
                }
                downstream.pipe(upstream);
                upstream.pipe(downstream);
            });
            upstream.once("error", () => downstream.destroy());
        });
        proxyServer.on("upgrade", (request, downstream, head) => {
            const destination = new URL(request.url ?? "/", "http://127.0.0.1");
            if (destination.origin !== `http://127.0.0.1:${port(relayServer)}`) {
                downstream.destroy();
                return;
            }
            tunnelTargets.push(destination.host);
            const upstream = connect(port(relayServer), "127.0.0.1", () => {
                const headers = Object.entries(request.headers)
                    .filter(([name]) => name !== "proxy-authorization")
                    .map(([name, value]) => `${name}: ${value}`)
                    .join("\r\n");
                upstream.write(`GET ${destination.pathname}${destination.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
                upstream.write(head);
                downstream.pipe(upstream);
                upstream.pipe(downstream);
            });
            upstream.once("error", () => downstream.destroy());
            downstream.once("close", () => upstream.destroy());
        });
        trackConnections(proxyServer, proxySockets);

        await Promise.all([listen(pairingServer), listen(relayServer), listen(proxyServer)]);

        const previousHttpProxy = process.env["HTTP_PROXY"];
        const previousHttpsProxy = process.env["HTTPS_PROXY"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerHttpProxy = process.env["http_proxy"];
        const previousLowerHttpsProxy = process.env["https_proxy"];
        const previousLowerNoProxy = process.env["no_proxy"];
        const previousStateDirectory = process.env["MORTY_STATE_DIRECTORY"];
        const previousPath = process.env["PATH"];
        const previousClaudePath = process.env["MORTY_CLAUDE_PATH"];
        const previousCodexPath = process.env["MORTY_CODEX_PATH"];
        const previousPiPath = process.env["MORTY_PI_PATH"];
        const proxyOrigin = `http://127.0.0.1:${port(proxyServer)}`;
        const proxyUrl = proxyOrigin.replace("http://", "http://morty:proxy-secret@");

        process.env["HTTP_PROXY"] = proxyUrl;
        process.env["HTTPS_PROXY"] = proxyUrl;
        process.env["NO_PROXY"] = "";
        delete process.env["http_proxy"];
        delete process.env["https_proxy"];
        delete process.env["no_proxy"];
        process.env["MORTY_STATE_DIRECTORY"] = stateDirectory;
        process.env["PATH"] = "";
        Object.assign(process.env, codex.environment);

        try {
            const { TestComputerHost } = await import("../support/computer-host.ts");
            const { connectRelay } = await import("../../src/engine/runtime/relay/connect.ts");
            const { describeEnvironmentProxyRoute, environmentProxyDispatcher } = await import(
                "../../src/engine/util/network/environment-proxy.ts"
            );

            const pairingPort = port(pairingServer);
            const engine = new TestComputerHost({
                dataDirectory: stateDirectory,
                agentLaunchEnvironment: process.env,
            });
            const paired = await engine.pair(
                {
                    defaultWorkspace: process.cwd(),
                    pairingCode: "ABCD-EFGH-JKLM-NPQR-STUV",
                    computerId: "proxy-computer",
                    relayOrigin: `http://127.0.0.1:${pairingPort}`,
                },
                AbortSignal.timeout(2_000),
            );
            expect(
                (
                    await (
                        await RuntimeInstallationStore.open(stateDirectory, AbortSignal.timeout(5_000))
                    ).readConnection(paired.pairingGeneration, AbortSignal.timeout(2_000))
                ).computerId,
            ).toBe("proxy-computer");

            const relayPort = port(relayServer);
            expect(describeEnvironmentProxyRoute(new URL(`ws://127.0.0.1:${relayPort}/daemon`))).toEqual({
                proxyOrigin,
                proxyRoute: "proxy",
            });
            const relayConnection = await connectRelay(
                new URL(`ws://127.0.0.1:${relayPort}/daemon`),
                {},
                AbortSignal.timeout(2_000),
            );
            relayConnection.socket.close();
            relayConnection.release(new Error("Proxy test completed"));

            expect(tunnelTargets).toContain(`127.0.0.1:${pairingPort}`);
            expect(tunnelTargets).toContain(`127.0.0.1:${relayPort}`);
            expect(pairingPaths).toEqual([`${MORTY_API_PREFIX}/v1/computers/proxy-computer/pairing/redeem`]);
            await environmentProxyDispatcher.close();
        } finally {
            if (previousHttpProxy === undefined) {
                delete process.env["HTTP_PROXY"];
            } else {
                process.env["HTTP_PROXY"] = previousHttpProxy;
            }
            if (previousHttpsProxy === undefined) {
                delete process.env["HTTPS_PROXY"];
            } else {
                process.env["HTTPS_PROXY"] = previousHttpsProxy;
            }
            if (previousNoProxy === undefined) {
                delete process.env["NO_PROXY"];
            } else {
                process.env["NO_PROXY"] = previousNoProxy;
            }
            if (previousLowerHttpProxy === undefined) {
                delete process.env["http_proxy"];
            } else {
                process.env["http_proxy"] = previousLowerHttpProxy;
            }
            if (previousLowerHttpsProxy === undefined) {
                delete process.env["https_proxy"];
            } else {
                process.env["https_proxy"] = previousLowerHttpsProxy;
            }
            if (previousLowerNoProxy === undefined) {
                delete process.env["no_proxy"];
            } else {
                process.env["no_proxy"] = previousLowerNoProxy;
            }
            if (previousStateDirectory === undefined) {
                delete process.env["MORTY_STATE_DIRECTORY"];
            } else {
                process.env["MORTY_STATE_DIRECTORY"] = previousStateDirectory;
            }
            if (previousPath === undefined) {
                delete process.env["PATH"];
            } else {
                process.env["PATH"] = previousPath;
            }
            if (previousClaudePath === undefined) {
                delete process.env["MORTY_CLAUDE_PATH"];
            } else {
                process.env["MORTY_CLAUDE_PATH"] = previousClaudePath;
            }
            if (previousCodexPath === undefined) {
                delete process.env["MORTY_CODEX_PATH"];
            } else {
                process.env["MORTY_CODEX_PATH"] = previousCodexPath;
            }
            if (previousPiPath === undefined) {
                delete process.env["MORTY_PI_PATH"];
            } else {
                process.env["MORTY_PI_PATH"] = previousPiPath;
            }
            await Promise.all([
                closeServer(pairingServer, pairingSockets),
                closeServer(relayServer, relaySockets),
                closeServer(proxyServer, proxySockets),
            ]);
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });
});
