import { createServer, type IncomingMessage, request } from "node:http";
import { COMPUTER_SUCCESSOR_CREDENTIAL_HEADER } from "@morty-build/client/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";

/** Forwards real traffic unchanged, with controllable ordering at the Relay transport boundary. */
export async function createSessionExecutionProxy(upstream: string) {
    const lifetime = new AbortController();
    const observers = new Map<
        string,
        {
            readonly execution: (
                encoded: string,
                signal: AbortSignal,
            ) => Promise<{
                readonly turn: string | null;
                readonly lastTurn: string | null;
                readonly lastTurnState: string | null;
                readonly interactionPosition: string | null;
            } | null>;
            readonly terminal: (encoded: string, signal: AbortSignal) => Promise<boolean>;
        }
    >();
    const responseHolds = new Map<string, (release: () => void) => void>();
    const takeResponseHold = (path: string) => {
        const suffix = [...responseHolds.keys()].find((candidate) => path.endsWith(candidate));
        const held = suffix === undefined ? undefined : responseHolds.get(suffix);
        if (suffix !== undefined) {
            responseHolds.delete(suffix);
        }
        return held;
    };
    let hold: ((release: () => void) => void) | null = null;
    // Requests held by the end of their path until released, each release returning the Computer's response.
    const heldReplies = new Map<string, (release: () => Promise<unknown>) => void>();
    let holdSubmission: ((release: () => void) => void) | null = null;
    let heldEvents: (() => void)[] | null = null;
    let heldTerminalEvents: Map<WebSocket, (() => void)[]> | null = null;
    let terminalObserved: (() => void) | null = null;
    let terminalFailed: ((cause: unknown) => void) | null = null;
    const executionReads: {
        readonly turn: string | null;
        readonly lastTurn: string | null;
        readonly lastTurnState: string | null;
        readonly interactionPosition: string | null;
    }[] = [];
    const server = createServer((incoming, outgoing) => {
        const heldResponse = takeResponseHold(new URL(incoming.url ?? "/", upstream).pathname);
        const requested = new URL(incoming.url ?? "/", upstream);
        const forwarded = request(
            new URL(upstream),
            {
                path: requested.pathname + requested.search,
                method: incoming.method,
                headers: { ...incoming.headers, host: new URL(upstream).host },
            },
            (response) => {
                if (heldResponse !== undefined) {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("end", () =>
                        heldResponse(() => {
                            outgoing.writeHead(response.statusCode ?? 502, response.headers);
                            outgoing.end(Buffer.concat(chunks));
                        }),
                    );
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
    const sockets = new Set<WebSocket>();
    const connections = new WebSocketServer({ noServer: true });
    server.on("upgrade", (incoming, socket, head) => {
        connections.handleUpgrade(incoming, socket, head, (client) => connections.emit("connection", client, incoming));
    });
    connections.on("connection", (client: WebSocket, incoming: IncomingMessage) => {
        const requested = new URL(incoming.url ?? "/", upstream);
        const target = new URL(upstream);
        target.pathname = requested.pathname;
        target.search = requested.search;
        const computerId = /^\/morty\/api\/v1\/computers\/([^/]+)\/transport$/u.exec(target.pathname)?.[1];
        target.protocol = "ws:";
        const remote = new WebSocket(target, {
            ...(incoming.headers.origin === undefined ? {} : { origin: incoming.headers.origin }),
            ...(incoming.headers.authorization === undefined
                ? {}
                : {
                      headers: {
                          authorization: incoming.headers.authorization,
                          ...(typeof incoming.headers[COMPUTER_SUCCESSOR_CREDENTIAL_HEADER] === "string"
                              ? {
                                    [COMPUTER_SUCCESSOR_CREDENTIAL_HEADER]:
                                        incoming.headers[COMPUTER_SUCCESSOR_CREDENTIAL_HEADER],
                                }
                              : {}),
                      },
                  }),
        });
        sockets.add(client);
        sockets.add(remote);
        const pending: (() => void)[] = [];
        const responses = new Map<string, (frame: unknown) => void>();
        const heldResponses = new Map<string, (release: () => void) => void>();
        const executionRequests = new Set<string>();
        client.on("message", (data, binary) => {
            const send = () => {
                if (remote.readyState === WebSocket.OPEN) {
                    remote.send(data, { binary });
                } else {
                    pending.push(() => remote.send(data, { binary }));
                }
            };
            const frame: unknown = binary ? null : jsonFrame(data.toString());
            const heldReply =
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.request" &&
                "path" in frame &&
                typeof frame.path === "string" &&
                "requestId" in frame &&
                typeof frame.requestId === "string"
                    ? { path: new URL(frame.path, upstream).pathname, requestId: frame.requestId }
                    : null;
            if (heldReply?.path.endsWith("/active-turn")) {
                executionRequests.add(heldReply.requestId);
            }
            if (heldReply !== null) {
                const heldResponse = takeResponseHold(heldReply.path);
                if (heldResponse !== undefined) {
                    heldResponses.set(heldReply.requestId, heldResponse);
                }
            }
            const heldSuffix =
                heldReply === null ? undefined : [...heldReplies.keys()].find((end) => heldReply.path.endsWith(end));
            const held = heldSuffix === undefined ? undefined : heldReplies.get(heldSuffix);
            if (heldReply !== null && heldSuffix !== undefined && held !== undefined) {
                heldReplies.delete(heldSuffix);
                const requestId = heldReply.requestId;
                const response = new Promise<unknown>((resolve) => responses.set(requestId, resolve));
                held(async () => {
                    send();
                    return await response;
                });
                return;
            }
            if (
                holdSubmission !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.request" &&
                "method" in frame &&
                frame.method === "POST" &&
                "path" in frame &&
                typeof frame.path === "string" &&
                new URL(frame.path, upstream).pathname.endsWith("/turns")
            ) {
                const held = holdSubmission;
                holdSubmission = null;
                held(send);
                return;
            }
            if (
                hold !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.request" &&
                "path" in frame &&
                typeof frame.path === "string" &&
                new URL(frame.path, upstream).pathname.endsWith("/active-turn")
            ) {
                const held = hold;
                hold = null;
                held(send);
                return;
            }
            send();
        });
        remote.on("open", () => {
            for (const send of pending.splice(0)) {
                send();
            }
        });
        let delivery = Promise.resolve();
        const receive = async (data: RawData, binary: boolean) => {
            const frame: unknown = binary ? null : jsonFrame(data.toString());
            if (
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.response" &&
                "requestId" in frame &&
                typeof frame.requestId === "string" &&
                executionRequests.delete(frame.requestId) &&
                "status" in frame &&
                frame.status === 200 &&
                "body" in frame &&
                typeof frame.body === "string"
            ) {
                const observer = computerId === undefined ? undefined : observers.get(decodeURIComponent(computerId));
                if (observer === undefined) {
                    throw new Error("An authorized Computer observer is required");
                }
                const snapshot = await observer.execution(frame.body, lifetime.signal);
                if (snapshot !== null) {
                    executionReads.push(snapshot);
                }
            }
            const send = () => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data, { binary });
                }
            };
            if (
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "http.response" &&
                "requestId" in frame &&
                typeof frame.requestId === "string"
            ) {
                const heldResponse = heldResponses.get(frame.requestId);
                if (heldResponse !== undefined) {
                    heldResponses.delete(frame.requestId);
                    heldResponse(send);
                    return;
                }
            }
            if (
                heldTerminalEvents !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "session.events.event" &&
                "data" in frame &&
                typeof frame.data === "string"
            ) {
                const observer = computerId === undefined ? undefined : observers.get(decodeURIComponent(computerId));
                if (observer === undefined) {
                    throw new Error("An authorized Computer observer is required");
                }
                const terminal = await observer.terminal(frame.data, lifetime.signal);
                const pending = heldTerminalEvents.get(client);
                if (pending !== undefined || terminal) {
                    const queue = pending ?? [];
                    queue.push(send);
                    heldTerminalEvents.set(client, queue);
                    if (terminal) {
                        terminalObserved?.();
                    }
                    return;
                }
            }
            if (
                heldEvents !== null &&
                typeof frame === "object" &&
                frame !== null &&
                "kind" in frame &&
                frame.kind === "session.events.event"
            ) {
                heldEvents.push(send);
                return;
            }
            send();
            if (
                typeof frame === "object" &&
                frame !== null &&
                "requestId" in frame &&
                typeof frame.requestId === "string"
            ) {
                responses.get(frame.requestId)?.(frame);
                responses.delete(frame.requestId);
            }
        };
        remote.on("message", (data, binary) => {
            delivery = delivery
                .then(() => receive(data, binary))
                .catch((cause: unknown) => {
                    if (!lifetime.signal.aborted) {
                        terminalFailed?.(cause);
                    }
                    client.terminate();
                    remote.terminate();
                });
        });
        for (const [socket, peer] of [
            [client, remote],
            [remote, client],
        ] as const) {
            socket.on("error", () => peer.terminate());
            socket.on("close", () => {
                sockets.delete(socket);
                peer.terminate();
            });
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Expected a listening proxy");
    }
    return {
        origin: `http://127.0.0.1:${address.port}`,
        observeComputer: (computerId: string, observer: NonNullable<ReturnType<typeof observers.get>>) => {
            observers.set(computerId, observer);
        },
        /** Holds one real HTTP or WebSocket response after the upstream has completed it, without changing it. */
        holdNextResponse: (suffix: string) =>
            new Promise<() => void>((resolve) => {
                responseHolds.set(suffix, (send) => {
                    let pending = true;
                    resolve(() => {
                        if (pending) {
                            pending = false;
                            send();
                        }
                    });
                });
            }),
        observedExecutionReads: () => [...executionReads],
        /** Delays real terminal events and every later event on the same connection without reordering them. */
        holdTerminalSessionEvents: () => {
            const pending = new Map<WebSocket, (() => void)[]>();
            const observed = Promise.withResolvers<void>();
            heldTerminalEvents = pending;
            terminalObserved = observed.resolve;
            terminalFailed = observed.reject;
            return {
                observed: observed.promise,
                release: () => {
                    heldTerminalEvents = null;
                    terminalObserved = null;
                    terminalFailed = null;
                    for (const queue of pending.values()) {
                        for (const send of queue) {
                            send();
                        }
                    }
                    pending.clear();
                },
            };
        },
        holdNextExecution: () =>
            new Promise<() => void>((resolve) => {
                hold = resolve;
            }),
        /** Holds the next turn submission before the Computer receives it, until the returned release. */
        holdNextSubmission: () =>
            new Promise<() => void>((resolve) => {
                holdSubmission = resolve;
            }),
        /** Holds the next steer before the Computer receives it; the release forwards it and returns the response. */
        holdNextSteer: () =>
            new Promise<() => Promise<unknown>>((resolve) => {
                heldReplies.set("/disposition", resolve);
            }),
        /** Holds the next withdrawal of a queued message; the release forwards it and returns the response. */
        holdNextQueuedCancellation: () =>
            new Promise<() => Promise<unknown>>((resolve) => {
                heldReplies.set("/cancel-before-start", resolve);
            }),
        holdSessionEvents: () => {
            const pending: (() => void)[] = [];
            heldEvents = pending;
            return () => {
                heldEvents = null;
                for (const send of pending.splice(0)) {
                    send();
                }
            };
        },
        close: async () => {
            lifetime.abort();
            observers.clear();
            for (const socket of sockets) {
                socket.terminate();
            }
            connections.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function jsonFrame(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
