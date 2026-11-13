import { once } from "node:events";
import { createServer } from "node:http";
import type { SessionEvent } from "@morty-build/client/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { MortyClient, MortyPageRequest, WsTransport } from "../src/index.ts";

const recordedAt = "2026-10-07T00:00:00.000Z";

function event(sessionId: string, eventId: string): SessionEvent {
    return {
        eventId,
        payload: {
            content: { text: eventId, type: "text" },
            messageId: "message-1",
            sessionUpdate: "agent_message_chunk",
        },
        recordedAt,
        sessionGenerationId: "session-generation-1",
        target: { harness: "claude", sessionId: sessionId },
        type: "acp",
    };
}

describe("Session Event Log V2 SDK", () => {
    const servers: ReturnType<typeof createServer>[] = [];

    afterEach(async () => {
        await Promise.all(
            servers.map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        servers.length = 0;
    });

    it("Given a V2 event page, When a consumer lists events with the default SDK, Then raw pages cross the WebSocket boundary unchanged", async () => {
        const sourceEvent = event("source-session", "source-event-1");
        const received: Array<{ readonly method: string; readonly path: string }> = [];
        const server = createServer();
        const peer = new WebSocketServer({ server });
        peer.on("connection", (socket) => {
            socket.on("message", (data) => {
                const request: unknown = JSON.parse(data.toString());
                if (
                    typeof request !== "object" ||
                    request === null ||
                    !("kind" in request) ||
                    request.kind !== "http.request" ||
                    !("path" in request) ||
                    typeof request.path !== "string" ||
                    !("method" in request) ||
                    typeof request.method !== "string" ||
                    !("requestId" in request)
                ) {
                    throw new Error("Expected a Session operation");
                }
                const path = request.path;
                received.push({ method: request.method, path });
                socket.send(
                    JSON.stringify({
                        kind: "http.response",
                        requestId: request.requestId,
                        status: 200,
                        headers: [],
                        body: JSON.stringify({
                            sessionGenerationId: "session-generation-1",
                            events: [sourceEvent],
                            nextCursor: null,
                            tailCursor: sourceEvent.eventId,
                            throughPosition: "1",
                            truncated: false,
                            version: 2,
                        }),
                    }),
                );
            });
        });
        servers.push(server);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected an IP server address");
        }
        const transport = new WsTransport();
        const client = new MortyClient({
            transport,
            credentialProvider: {
                credential: async (signal: AbortSignal) => {
                    signal.throwIfAborted();
                    return "test-credential";
                },
            },
            endpoint: `http://127.0.0.1:${address.port}`,
            computerId: "computer-1",
        });
        const signal = new AbortController().signal;

        try {
            expect(await client.events.list(sourceEvent.target, new MortyPageRequest(500, ""), signal)).toEqual({
                sessionGenerationId: "session-generation-1",
                events: [sourceEvent],
                nextCursor: null,
                tailCursor: sourceEvent.eventId,
                throughPosition: "1",
                truncated: false,
                version: 2,
            });
        } finally {
            client.close();
            transport.close();
            for (const socket of peer.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve, reject) => peer.close((error) => (error ? reject(error) : resolve())));
        }

        expect(received).toEqual([
            {
                method: "GET",
                path: "/morty/api/v1/computers/computer-1/harnesses/claude/sessions/source-session/events?limit=500",
            },
        ]);
    });
});
