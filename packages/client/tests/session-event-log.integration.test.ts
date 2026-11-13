import { once } from "node:events";
import { createServer } from "node:http";
import type { NativeSessionTarget, SessionEvent } from "@morty-build/client/protocol";
import { base64urlnopad } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createComputerPayloadEncryption, exportE2EPublicKey, generateE2EIdentity } from "../src/encryption.ts";
import { MortyProtocolError } from "../src/errors.ts";
import { MortyClient, MortyPageRequest, WsTransport } from "../src/index.ts";
import {
    contentAvailableEventCodec,
    contentChunkCodec,
    contentCommitCommandCodec,
    contentWriteCommandCodec,
    decodeContentChunkFrame,
    decodeFileStreamRecord,
    encodeFileStreamRecord,
    fileBeginEventCodec,
    fileEndEventCodec,
    fileReadCommandCodec,
} from "../src/protocol/session/files/index.ts";
import {
    sessionHistoryPageLoadCodec,
    sessionHistoryPageLoadedCodec,
} from "../src/protocol/session/observability/history.ts";

const recordedAt = "2026-10-07T00:00:00.000Z";

function event(eventId: string): SessionEvent {
    return {
        eventId,
        payload: {
            content: { text: eventId, type: "text" },
            messageId: "message-1",
            sessionUpdate: "agent_message_chunk",
        },
        recordedAt,
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

    it("Given access for one Computer, when a client selects another Computer, then construction rejects the mismatched access", async () => {
        const identity = await generateE2EIdentity();
        const access = {
            computerId: "computer-1",
            computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
            computerE2EAccessSecret: base64urlnopad.encode(new Uint8Array(32).fill(13)),
        };
        const transport = new WsTransport();
        try {
            expect(
                () =>
                    new MortyClient({
                        transport,
                        encryption: { access },
                        credentialProvider: { credential: async () => "test-credential" },
                        endpoint: "http://127.0.0.1",
                        computerId: "computer-2",
                    }),
            ).toThrow("Encrypted access does not match the selected Computer");
        } finally {
            transport.close();
        }
    });

    it("Given attachment bytes, when a client uploads them, then the Computer sees the encrypted write, chunks and commit and the client receives the attachment", async () => {
        vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") });
        const identity = await generateE2EIdentity();
        const access = {
            computerId: "computer-1",
            computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
            computerE2EAccessSecret: base64urlnopad.encode(new Uint8Array(32).fill(12)),
        };
        const signal = new AbortController().signal;
        const box = await createComputerPayloadEncryption(access, async () => {}, signal);
        const target = { harness: "claude", sessionId: "session-1" };
        const bytes = new TextEncoder().encode("private attachment contents");
        const contentKey = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
            byte.toString(16).padStart(2, "0"),
        ).join("");
        const server = createServer();
        const peer = new WebSocketServer({ server });
        peer.on("connection", (socket) => {
            let pending: {
                readonly id: string;
                readonly length: number;
                readonly parts: Uint8Array[];
                size: number;
            } | null = null;
            socket.on("message", async (data, isBinary) => {
                if (!isBinary) {
                    const message: unknown = JSON.parse(data.toString());
                    if (
                        typeof message !== "object" ||
                        message === null ||
                        !("kind" in message) ||
                        message.kind !== "http.request" ||
                        !("requestId" in message) ||
                        typeof message.requestId !== "string" ||
                        !("bodyByteLength" in message) ||
                        typeof message.bodyByteLength !== "number" ||
                        !("path" in message) ||
                        typeof message.path !== "string"
                    ) {
                        throw new Error("Expected binary PUT request");
                    }
                    expect(message.path).toContain(`/content/${contentKey}`);
                    expect(data.toString()).not.toContain("private attachment contents");
                    pending = { id: message.requestId, length: message.bodyByteLength, parts: [], size: 0 };
                    return;
                }
                if (pending === null) {
                    throw new Error("Unexpected upload chunk");
                }
                const outer = decodeContentChunkFrame(data);
                expect(outer.requestId).toBe(pending.id);
                pending.parts.push(outer.bytes);
                pending.size += outer.bytes.length;
                if (pending.size !== pending.length) {
                    return;
                }
                const wire = new Uint8Array(pending.length);
                let position = 0;
                for (const part of pending.parts) {
                    wire.set(part, position);
                    position += part.length;
                }
                expect(new TextDecoder().decode(wire)).not.toContain("private attachment contents");
                const first = decodeFileStreamRecord(wire);
                if (first.kind !== "record" || first.record.kind !== "message") {
                    throw new Error("Expected content.write");
                }
                const write = await contentWriteCommandCodec.decode(first.record.encoded, box, signal);
                expect(write).toMatchObject({
                    kind: "content.write",
                    contentKey,
                    byteLength: bytes.length,
                    target,
                    name: "private.txt",
                });
                const second = decodeFileStreamRecord(wire.subarray(first.byteLength));
                if (second.kind !== "record" || second.record.kind !== "chunk") {
                    throw new Error("Expected content chunk");
                }
                const decodedChunk = await contentChunkCodec.decode(second.record.encoded, box, signal);
                expect(decodedChunk).toEqual({ requestId: write.requestId, sequence: 0, bytes });
                const third = decodeFileStreamRecord(wire.subarray(first.byteLength + second.byteLength));
                if (third.kind !== "record" || third.record.kind !== "message") {
                    throw new Error("Expected content.commit");
                }
                expect(await contentCommitCommandCodec.decode(third.record.encoded, box, signal)).toEqual({
                    kind: "content.commit",
                    requestId: write.requestId,
                    target,
                });
                expect(first.byteLength + second.byteLength + third.byteLength).toBe(wire.length);
                const body = await contentAvailableEventCodec.encode(
                    {
                        kind: "content.available",
                        requestId: write.requestId,
                        target,
                        contentKey,
                        byteLength: bytes.length,
                    },
                    box,
                    signal,
                );
                socket.send(
                    JSON.stringify({ kind: "http.response", requestId: pending.id, status: 200, headers: [], body }),
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
            encryption: { access },
            credentialProvider: { credential: async () => "test-credential" },
            endpoint: `http://127.0.0.1:${address.port}`,
            computerId: "computer-1",
        });
        const uri = `morty-content:resource:${contentKey}`;
        try {
            expect(
                await client.sessions.uploadContent(
                    target,
                    { bytes, contentKey, kind: "resource", mediaType: "text/plain", name: "private.txt", uri },
                    signal,
                ),
            ).toEqual({
                byteLength: bytes.length,
                contentKey,
                kind: "resource",
                mimeType: "text/plain",
                name: "private.txt",
                uri,
            });
        } finally {
            client.close();
            transport.close();
            box.close();
            vi.useRealTimers();
            for (const socket of peer.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve, reject) => peer.close((error) => (error ? reject(error) : resolve())));
        }
    });

    /** A Computer that answers an encrypted file read over HTTP: `answer` chooses which request the stream answers. */
    async function withFileReadServer(
        answer: (read: { readonly requestId: string }) => string,
        scenario: (client: MortyClient, target: NativeSessionTarget) => Promise<void>,
    ): Promise<void> {
        vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") });
        const identity = await generateE2EIdentity();
        const access = {
            computerId: "computer-1",
            computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
            computerE2EAccessSecret: base64urlnopad.encode(new Uint8Array(32).fill(11)),
        };
        const signal = new AbortController().signal;
        const box = await createComputerPayloadEncryption(access, async () => {}, signal);
        const target = { harness: "claude", sessionId: "session-1" };
        const bytes = new TextEncoder().encode("private file contents");
        const server = createServer((request, response) => {
            void (async () => {
                const chunks: Buffer[] = [];
                for await (const chunk of request) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                const body = Buffer.concat(chunks).toString();
                expect(request.method).toBe("POST");
                expect(request.url).not.toContain("?");
                expect(body).not.toContain("private.txt");
                const read = await fileReadCommandCodec.decode(body, box, signal);
                expect(read.path).toBe("/workspace/private.txt");
                expect(read.maxBytes).toBe(4096);
                const requestId = answer(read);
                const records = [
                    encodeFileStreamRecord({
                        kind: "message",
                        encoded: await fileBeginEventCodec.encode(
                            {
                                kind: "file.begin",
                                requestId,
                                target,
                                byteLength: bytes.length,
                                mediaType: "text/plain",
                                modifiedAt: "2026-10-07T00:00:00.000Z",
                                name: "private.txt",
                            },
                            box,
                            signal,
                        ),
                    }),
                    encodeFileStreamRecord({
                        kind: "chunk",
                        encoded: await contentChunkCodec.encode({ requestId, sequence: 0, bytes }, box, signal),
                    }),
                    encodeFileStreamRecord({
                        kind: "message",
                        encoded: await fileEndEventCodec.encode({ kind: "file.end", requestId, target }, box, signal),
                    }),
                ];
                expect(new TextDecoder().decode(records[1])).not.toContain("private file contents");
                response.writeHead(200, { "content-type": "application/vnd.morty.encrypted-file" });
                for (const record of records) {
                    response.write(record.subarray(0, 2));
                    response.write(record.subarray(2));
                }
                response.end();
            })().catch((cause: unknown) => response.destroy(cause instanceof Error ? cause : undefined));
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
            encryption: { access },
            credentialProvider: { credential: async () => "test-credential" },
            endpoint: `http://127.0.0.1:${address.port}`,
            computerId: "computer-1",
        });
        try {
            await scenario(client, target);
        } finally {
            client.close();
            transport.close();
            box.close();
            vi.useRealTimers();
        }
    }

    it("Given an encrypted file download, when a client reads it, then only the client recovers the bytes and metadata", async () => {
        await withFileReadServer(
            (read) => read.requestId,
            async (client, target) => {
                expect(
                    await client.sessions.readFile(
                        target,
                        "/workspace/private.txt",
                        new AbortController().signal,
                        4096,
                    ),
                ).toEqual({
                    bytes: new TextEncoder().encode("private file contents"),
                    mediaType: "text/plain",
                    modifiedAt: "2026-10-07T00:00:00.000Z",
                    name: "private.txt",
                });
            },
        );
    });

    it("Given an encrypted file stream that answers another read, when a client reads a file, then it refuses the file instead of showing it", async () => {
        await withFileReadServer(
            () => "another-request",
            async (client, target) => {
                await expect(
                    client.sessions.readFile(target, "/workspace/private.txt", new AbortController().signal, 4096),
                ).rejects.toBeInstanceOf(MortyProtocolError);
            },
        );
    });

    it("Given a V2 event page, When a consumer lists events with the default SDK, Then raw pages cross the WebSocket boundary unchanged", async () => {
        vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") });
        const identity = await generateE2EIdentity();
        const accessSecret = base64urlnopad.encode(new Uint8Array(32).fill(7));
        const access = {
            computerId: "computer-1",
            computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
            computerE2EAccessSecret: accessSecret,
        };
        const sourceTarget = { harness: "claude", sessionId: "source-session" };
        const sourceEvent = event("source-event-1");
        const received: Array<{ readonly method: string; readonly path: string }> = [];
        const claims = new Set<string>();
        const server = createServer();
        const peer = new WebSocketServer({ server });
        peer.on("connection", (socket) => {
            socket.on("message", async (data) => {
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
                if (!("headers" in request) || !Array.isArray(request.headers)) {
                    throw new Error("Expected request headers");
                }
                expect(new Headers(request.headers).get("content-type")).toBe("application/json");
                if (!("body" in request) || typeof request.body !== "string") {
                    throw new Error("Expected an encrypted command");
                }
                const wire = request.body;
                const packet: unknown = JSON.parse(wire);
                if (
                    typeof packet !== "object" ||
                    packet === null ||
                    !("encrypted" in packet) ||
                    typeof packet.encrypted !== "string"
                ) {
                    throw new Error("Expected ciphertext");
                }
                const signal = new AbortController().signal;
                const box = await createComputerPayloadEncryption(
                    access,
                    async (claim) => {
                        if (claims.has(claim.fingerprint)) {
                            throw new Error("Replayed payload");
                        }
                        claims.add(claim.fingerprint);
                    },
                    signal,
                );
                const command = await sessionHistoryPageLoadCodec.decode(wire, box, signal);
                expect(command).toMatchObject({ target: sourceTarget, eventLimit: 500, cursor: null });
                const body = await sessionHistoryPageLoadedCodec.encode(
                    {
                        kind: "session.live-history.v2.page.loaded",
                        requestId: command.requestId,
                        target: command.target,
                        events: {
                            events: {
                                sessionGenerationId: "session-generation-1",
                                events: [sourceEvent],
                                nextCursor: null,
                                throughPosition: "1",
                            },
                        },
                    },
                    box,
                    signal,
                );
                expect(wire).not.toContain("source-event-1");
                expect(body).not.toContain("source-event-1");
                socket.send(
                    JSON.stringify({
                        kind: "http.response",
                        requestId: request.requestId,
                        status: 200,
                        headers: [],
                        body,
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
            encryption: { access },
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
            expect(await client.events.list(sourceTarget, new MortyPageRequest(500, ""), signal)).toEqual({
                sessionGenerationId: "session-generation-1",
                events: [sourceEvent],
                nextCursor: null,
                throughPosition: "1",
            });
        } finally {
            client.close();
            transport.close();
            vi.useRealTimers();
            for (const socket of peer.clients) {
                socket.terminate();
            }
            await new Promise<void>((resolve, reject) => peer.close((error) => (error ? reject(error) : resolve())));
        }

        expect(received).toEqual([
            {
                method: "GET",
                path: "/morty/api/v1/computers/computer-1/harnesses/claude/sessions/source-session/events",
            },
        ]);
    });
});
