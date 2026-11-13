import { EventEmitter, once } from "node:events";
import { createServer, request } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { listen, port } from "./websocket.ts";

function jsonFrame(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

/** The text of a response body as the service encoded it on the wire. */
function decoded(encoding: string | undefined, chunks: readonly Buffer[]): string {
    const body = Buffer.concat(chunks);
    switch (encoding) {
        case "gzip":
            return gunzipSync(body).toString("utf8");
        case "br":
            return brotliDecompressSync(body).toString("utf8");
        case "deflate":
            return inflateSync(body).toString("utf8");
        default:
            return body.toString("utf8");
    }
}

/**
 * A real network proxy: forwards requests unchanged, then loses one request before it reaches the service, one request's
 * response, one turn admission response, or delays one request.
 */
export async function createResponseLossProxy(upstream: string) {
    // The next response to lose: the service handles the request, but the caller never receives its answer.
    let lostResponse: {
        readonly path: RegExp;
        readonly lost: (response: { readonly status: number; readonly body: string }) => void;
    } | null = null;
    const loseNextResponseWithBody = (path: RegExp) =>
        new Promise<{ readonly status: number; readonly body: string }>((resolve) => {
            lostResponse = { path, lost: resolve };
        });
    const loseNextResponse = async (path: RegExp) => (await loseNextResponseWithBody(path)).status;
    // The next request to lose on its way: the service never receives it.
    let droppedRequest: RegExp | null = null;
    let holdSharing: {
        readonly receive: (body: string, disconnect: () => void) => void;
    } | null = null;
    const server = createServer((incoming, outgoing) => {
        if (droppedRequest !== null && incoming.method === "POST" && droppedRequest.test(incoming.url ?? "")) {
            droppedRequest = null;
            incoming.resume();
            outgoing.destroy();
            return;
        }
        const forwarded = request(
            new URL(incoming.url ?? "/", upstream),
            {
                method: incoming.method,
                headers: { ...incoming.headers, host: new URL(upstream).host },
            },
            (response) => {
                if (
                    holdSharing !== null &&
                    incoming.method === "POST" &&
                    incoming.url?.endsWith("/identity/transfers")
                ) {
                    const held = holdSharing;
                    holdSharing = null;
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("end", () =>
                        held.receive(decoded(response.headers["content-encoding"], chunks), () => outgoing.destroy()),
                    );
                    return;
                }
                if (lostResponse !== null && incoming.method === "POST" && lostResponse.path.test(incoming.url ?? "")) {
                    const { lost } = lostResponse;
                    lostResponse = null;
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("end", () => {
                        lost({
                            status: response.statusCode ?? 502,
                            body: decoded(response.headers["content-encoding"], chunks),
                        });
                        outgoing.destroy();
                    });
                    return;
                }
                outgoing.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(outgoing);
            },
        );
        forwarded.on("error", () => outgoing.destroy());
        incoming.on("aborted", () => forwarded.destroy());
        incoming.pipe(forwarded);
    });
    let heldConfiguration: { readonly client: WebSocket; readonly data: Buffer; readonly binary: boolean } | null =
        null;
    let holdConfiguration: { readonly resolve: () => void } | null = null;
    const sockets = new Set<WebSocket>();
    const browserSockets = new Set<WebSocket>();
    let browserConnectionsOpened = 0;
    const webSockets = new WebSocketServer({ server });
    let armed: "before-acceptance" | "after-acceptance" | "held" | null = null;
    let lostSubmission: { readonly client: WebSocket; readonly requestId: string } | null = null;
    // A held submission reaches the service only when the scenario releases it, as a slow network would deliver it.
    const held: { readonly release: () => void }[] = [];
    let reconnectsBlocked = false;
    const submissions: string[] = [];
    const turnArrivals = new EventEmitter();
    const interruptBrowserNetwork = () => {
        reconnectsBlocked = true;
        for (const socket of browserSockets) {
            socket.terminate();
        }
    };
    webSockets.on("connection", (client, incoming) => {
        const computer = new URL(incoming.url ?? "/", upstream).pathname.endsWith("/computers/connect");
        if (reconnectsBlocked && !computer) {
            client.terminate();
            return;
        }
        sockets.add(client);
        if (!computer) {
            browserConnectionsOpened += 1;
            browserSockets.add(client);
            turnArrivals.emit("browser-connections", browserSockets.size);
        }
        const target = new URL(incoming.url ?? "/", upstream);
        target.protocol = "ws:";
        const remote = new WebSocket(target, {
            ...(incoming.headers.origin === undefined ? {} : { origin: incoming.headers.origin }),
            // Keep the browser's authority and Origin together across this transparent proxy.
            headers: {
                ...(incoming.headers[COMPUTER_SUCCESSOR_CREDENTIAL_HEADER] === undefined
                    ? {}
                    : {
                          [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]:
                              incoming.headers[COMPUTER_SUCCESSOR_CREDENTIAL_HEADER],
                      }),
                ...(incoming.headers.host === undefined ? {} : { host: incoming.headers.host }),
                ...(incoming.headers.authorization === undefined
                    ? {}
                    : { authorization: incoming.headers.authorization }),
                ...(incoming.headers[COMPUTER_SUCCESSOR_CREDENTIAL_HEADER] === undefined
                    ? {}
                    : {
                          [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]:
                              incoming.headers[COMPUTER_SUCCESSOR_CREDENTIAL_HEADER],
                      }),
            },
        });
        sockets.add(remote);
        let configurationResponse: { readonly requestId: string; readonly ready: () => void } | null = null;
        const pending: { readonly data: Buffer; readonly binary: boolean }[] = [];
        const responseFaults = new Map<
            string,
            (response: { readonly status: number; readonly body: string }) => void
        >();
        const forward = (data: Buffer, binary: boolean) => {
            if (remote.readyState === WebSocket.OPEN) {
                remote.send(data, { binary });
            } else {
                pending.push({ data, binary });
            }
        };
        client.on("message", (data, binary) => {
            const bytes = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(new Uint8Array(data));
            if (!binary) {
                const frame = jsonFrame(bytes.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.request" &&
                    "method" in frame &&
                    frame.method === "POST" &&
                    "path" in frame &&
                    typeof frame.path === "string" &&
                    "requestId" in frame &&
                    typeof frame.requestId === "string"
                ) {
                    if (droppedRequest?.test(frame.path)) {
                        droppedRequest = null;
                        client.terminate();
                        return;
                    }
                    if (holdSharing !== null && frame.path.endsWith("/identity/transfers")) {
                        const held = holdSharing;
                        holdSharing = null;
                        responseFaults.set(frame.requestId, (response) => {
                            held.receive(response.body, () => client.terminate());
                        });
                    } else if (lostResponse?.path.test(frame.path)) {
                        const { lost } = lostResponse;
                        lostResponse = null;
                        responseFaults.set(frame.requestId, (response) => {
                            lost(response);
                            client.terminate();
                        });
                    }
                }
                if (
                    holdConfiguration !== null &&
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.request" &&
                    "method" in frame &&
                    frame.method === "POST" &&
                    "path" in frame &&
                    typeof frame.path === "string" &&
                    frame.path.endsWith("/configuration") &&
                    "requestId" in frame &&
                    typeof frame.requestId === "string"
                ) {
                    configurationResponse = { requestId: frame.requestId, ready: holdConfiguration.resolve };
                    holdConfiguration = null;
                }

                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.request" &&
                    "method" in frame &&
                    frame.method === "POST" &&
                    "path" in frame &&
                    typeof frame.path === "string" &&
                    frame.path.endsWith("/turns") &&
                    "requestId" in frame &&
                    typeof frame.requestId === "string" &&
                    "body" in frame &&
                    typeof frame.body === "string"
                ) {
                    submissions.push(frame.body);
                    turnArrivals.emit("submission", frame.body);
                    if (armed === "held") {
                        armed = null;
                        held.push({ release: () => forward(bytes, binary) });
                        return;
                    }
                    if (armed !== null) {
                        const delivery = armed;
                        armed = null;
                        if (delivery === "before-acceptance") {
                            interruptBrowserNetwork();
                            return;
                        }
                        lostSubmission = { client, requestId: frame.requestId };
                    }
                }
            }
            forward(bytes, binary);
        });
        remote.on("open", () => {
            for (const frame of pending.splice(0)) {
                remote.send(frame.data, { binary: frame.binary });
            }
        });
        remote.on("message", (data, binary) => {
            if (!binary && responseFaults.size > 0) {
                const frame = jsonFrame(data.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.response" &&
                    "requestId" in frame &&
                    typeof frame.requestId === "string" &&
                    "status" in frame &&
                    typeof frame.status === "number" &&
                    "body" in frame &&
                    typeof frame.body === "string"
                ) {
                    const fault = responseFaults.get(frame.requestId);
                    if (fault !== undefined) {
                        responseFaults.delete(frame.requestId);
                        fault({ status: frame.status, body: frame.body });
                        return;
                    }
                }
            }
            if (configurationResponse !== null && !binary) {
                const frame = jsonFrame(data.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.response" &&
                    "requestId" in frame &&
                    frame.requestId === configurationResponse.requestId
                ) {
                    heldConfiguration = { client, data: Buffer.from(data.toString()), binary };
                    configurationResponse.ready();
                    configurationResponse = null;
                    return;
                }
            }

            // A separate viewing connection must not confirm the delivery whose response this fault loses.
            if (!computer && lostSubmission !== null) {
                const frame = binary ? null : jsonFrame(data.toString());
                if (
                    typeof frame === "object" &&
                    frame !== null &&
                    "kind" in frame &&
                    frame.kind === "http.response" &&
                    "requestId" in frame &&
                    lostSubmission.client === client &&
                    frame.requestId === lostSubmission.requestId
                ) {
                    // The service accepted the request. Lose its response and any confirming live events.
                    interruptBrowserNetwork();
                }
                return;
            }
            if (client.readyState === WebSocket.OPEN) {
                client.send(data, { binary });
            }
        });
        client.on("error", () => remote.terminate());
        remote.on("error", () => client.terminate());
        client.on("close", () => {
            sockets.delete(client);
            browserSockets.delete(client);
            turnArrivals.emit("browser-connections", browserSockets.size);
            remote.terminate();
        });
        remote.on("close", () => {
            sockets.delete(remote);
            client.terminate();
        });
    });
    await listen(server);
    return {
        origin: `http://127.0.0.1:${port(server)}`,
        submissions,
        get browserConnectionsOpened(): number {
            return browserConnectionsOpened;
        },
        waitForBrowserConnections: async (count: number, signal: AbortSignal): Promise<void> => {
            signal.throwIfAborted();
            if (browserSockets.size === count) {
                return;
            }
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    turnArrivals.removeListener("browser-connections", changed);
                    signal.removeEventListener("abort", aborted);
                };
                const changed = (connected: number) => {
                    if (connected === count) {
                        cleanup();
                        resolve();
                    }
                };
                const aborted = () => {
                    cleanup();
                    reject(signal.reason);
                };
                turnArrivals.on("browser-connections", changed);
                signal.addEventListener("abort", aborted, { once: true });
            });
        },
        nextSubmission: async (signal: AbortSignal): Promise<string> => {
            const [body]: unknown[] = await once(turnArrivals, "submission", { signal });
            if (typeof body !== "string") {
                throw new Error("Expected an arriving Turn submission");
            }
            return body;
        },
        /** Holds a committed Chat sharing response, then loses it when the scenario disconnects the network. */
        holdNextSharingResponse: () => {
            const received = Promise.withResolvers<string>();
            let disconnect: (() => void) | null = null;
            holdSharing = {
                receive: (body, close) => {
                    disconnect = close;
                    received.resolve(body);
                },
            };
            return {
                received: received.promise,
                disconnect: () => {
                    if (disconnect === null) {
                        throw new Error("The sharing response has not arrived");
                    }
                    disconnect();
                },
            };
        },
        /** Holds one real settings edit response, letting later notifications and reads pass unchanged. */
        holdNextConfigurationResponse: () =>
            new Promise<void>((resolve) => {
                holdConfiguration = { resolve };
            }),
        releaseConfigurationResponse: () => {
            if (heldConfiguration !== null) {
                heldConfiguration.client.send(heldConfiguration.data, { binary: heldConfiguration.binary });
                heldConfiguration = null;
            }
        },
        /** Loses a pairing response after the real service commits it. */
        interruptNextComputerPairing: () => loseNextResponseWithBody(/\/pairing(?:\?|$)/u),
        interruptNextFork: () => loseNextResponse(/\/native-sessions\/forks\//u),
        /** Loses the next Session creation before it reaches the service, which therefore creates nothing. */
        dropNextSessionCreation: () => {
            droppedRequest = /\/managed-sessions\/open(?:\?|$)/u;
        },
        /** Loses the answer to the next Session creation; resolves with the status the service returned. */
        interruptNextSessionCreation: () => loseNextResponse(/\/managed-sessions\/open(?:\?|$)/u),
        interruptNextTurn: (delivery: "before-acceptance" | "after-acceptance") => {
            armed = delivery;
        },
        /** Delays the next turn submission on the network until released; the browser cannot tell it was sent. */
        holdNextTurn: () => {
            armed = "held";
        },
        releaseHeldTurn: () => {
            for (const request of held.splice(0)) {
                request.release();
            }
        },
        reconnect: () => {
            lostSubmission = null;
            reconnectsBlocked = false;
        },
        close: async () => {
            for (const socket of sockets) {
                socket.terminate();
            }
            webSockets.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
