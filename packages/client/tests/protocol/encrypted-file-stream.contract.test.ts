import { base64urlnopad } from "@scure/base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    createClientPayloadEncryption,
    createComputerPayloadEncryption,
    exportE2EPublicKey,
    generateE2EIdentity,
} from "../../src/encryption.ts";
import {
    contentChunkCodec,
    decodeClientToRelayMessage,
    decodeDaemonToRelayMessage,
    decodeFileStreamRecord,
    decodeWorkerRequestRejected,
    encodeFileStreamRecord,
    encodeWorkerRequestRejected,
    FILE_STREAM_MAX_CHUNK_BYTES,
    fileBeginEventCodec,
    fileEndEventCodec,
    fileReadCommandCodec,
    sessionOperationFailedEventCodec,
} from "../../src/protocol/index.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T00:00:00Z") }));
afterEach(() => vi.useRealTimers());

it("Given a file GET, when the Worker forwards the clear request and encrypted response records, then the client decrypts the original file", async () => {
    const signal = new AbortController().signal;
    const identity = await generateE2EIdentity();
    const access = {
        computerId: "computer-1",
        computerE2EPublicKey: await exportE2EPublicKey(identity.publicKey),
        computerE2EAccessSecret: base64urlnopad.encode(new Uint8Array(32).fill(12)),
    };
    const client = await createClientPayloadEncryption(access, signal);
    const claims = new Set<string>();
    const computer = await createComputerPayloadEncryption(
        access,
        async (claim) => {
            if (claims.has(claim.fingerprint)) {
                throw new Error("Replay");
            }
            claims.add(claim.fingerprint);
        },
        signal,
    );
    const target = { harness: "codex", sessionId: "session-1" };
    const request = {
        kind: "file.read",
        requestId: "request-1",
        target,
        path: "/workspace/private.txt",
        maxBytes: 4096,
    };
    const clearRequest = await fileReadCommandCodec.encode(request, client, signal);
    expect(decodeClientToRelayMessage(clearRequest)).toEqual(request);

    const begin = {
        kind: "file.begin",
        requestId: request.requestId,
        target,
        name: "private.txt",
        mediaType: "text/plain",
        byteLength: 3,
        modifiedAt: "2026-11-12T00:00:00Z",
    };
    const end = { kind: "file.end", requestId: request.requestId, target };
    const chunk = { requestId: request.requestId, sequence: 0, bytes: new Uint8Array([1, 2, 3]) };
    const beginWire = await fileBeginEventCodec.encode(begin, computer, signal);
    const chunkWire = await contentChunkCodec.encode(chunk, computer, signal);
    const endWire = await fileEndEventCodec.encode(end, computer, signal);
    const records = [
        encodeFileStreamRecord({ kind: "message", encoded: beginWire }),
        encodeFileStreamRecord({ kind: "chunk", encoded: chunkWire }),
        encodeFileStreamRecord({ kind: "message", encoded: endWire }),
    ];
    const response = new Uint8Array(records.reduce((sum, record) => sum + record.byteLength, 0));
    let offset = 0;
    for (const record of records) {
        response.set(record, offset);
        offset += record.byteLength;
    }
    expect(new TextDecoder().decode(response)).not.toContain("private.txt");
    expect(decodeFileStreamRecord(response.subarray(0, 4))).toEqual({ kind: "incomplete" });
    expect(decodeFileStreamRecord(response.subarray(0, records[0]?.byteLength ?? 0).subarray(0, -1))).toEqual({
        kind: "incomplete",
    });
    const first = decodeFileStreamRecord(response);
    expect(first.kind).toBe("record");
    if (first.kind !== "record" || first.record.kind !== "message") {
        throw new Error("Expected file begin");
    }
    expect(await fileBeginEventCodec.decode(first.record.encoded, client, signal)).toEqual(begin);
    const second = decodeFileStreamRecord(response.subarray(first.byteLength));
    if (second.kind !== "record" || second.record.kind !== "chunk") {
        throw new Error("Expected file chunk");
    }
    expect(await contentChunkCodec.decode(second.record.encoded, client, signal)).toEqual(chunk);
    const third = decodeFileStreamRecord(response.subarray(first.byteLength + second.byteLength));
    if (third.kind !== "record" || third.record.kind !== "message") {
        throw new Error("Expected file end");
    }
    expect(await fileEndEventCodec.decode(third.record.encoded, client, signal)).toEqual(end);
    expect(first.byteLength + second.byteLength + third.byteLength).toBe(response.byteLength);
});

it("Given an invalid file stream header, when a client reads it, then it rejects the declared size before buffering a body", () => {
    const oversized = new Uint8Array(5);
    oversized[0] = 1;
    new DataView(oversized.buffer).setUint32(1, FILE_STREAM_MAX_CHUNK_BYTES + 1);
    expect(() => decodeFileStreamRecord(oversized)).toThrowError();
    expect(() => decodeFileStreamRecord(new Uint8Array([2, 0, 0, 0, 1]))).toThrowError();
});

it("Given a Worker refusal, when a client reads it, then it remains distinct from a Computer-authored failure", () => {
    const refusal = {
        kind: "worker.request.rejected" as const,
        requestId: "request-1",
        code: "computer_offline",
        message: "The local computer is offline",
    };
    const encoded = encodeWorkerRequestRejected(refusal);
    expect(decodeWorkerRequestRejected(encoded)).toEqual(refusal);
    expect(() => decodeClientToRelayMessage(encoded)).toThrowError();
    expect(() => decodeDaemonToRelayMessage(encoded)).toThrowError();
    expect(() =>
        sessionOperationFailedEventCodec.decodeRouting(
            JSON.stringify({
                ...refusal,
                kind: "session.operation.failed",
            }),
        ),
    ).toThrowError();
});
