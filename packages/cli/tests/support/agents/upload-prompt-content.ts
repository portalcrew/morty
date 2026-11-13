import { createHash, randomUUID } from "node:crypto";
import {
    CONTENT_CHUNK_MAX_BYTES,
    decodeContentAvailableEvent,
    decodeContentChunkAck,
    decodeContentReadyEvent,
    decodeMessageKind,
    encodeContentChunkFrame,
    encodeContentCommitCommand,
    encodeContentWriteCommand,
    type PromptAttachment,
} from "@morty-build/client/protocol";
import type { RealDaemonPeer } from "./real-daemon.ts";

export async function uploadPromptContent(
    peer: RealDaemonPeer,
    input: {
        readonly bytes: Uint8Array;
        readonly kind: "image" | "resource";
        readonly mediaType: string;
        readonly name: string;
        readonly uri: string;
    },
): Promise<PromptAttachment> {
    const contentKey = createHash("sha256").update(input.bytes).digest("hex");
    const requestId = randomUUID();
    peer.send(
        encodeContentWriteCommand({
            byteLength: input.bytes.byteLength,
            contentKey,
            contentKind: input.kind,
            kind: "content.write",
            mediaType: input.mediaType,
            name: input.name,
            requestId,
            target: peer.target,
        }),
    );
    const ready = await peer.nextMessage();
    if (decodeMessageKind(ready) !== "content.ready" || decodeContentReadyEvent(ready).requestId !== requestId) {
        throw new Error("The daemon did not accept the content upload");
    }
    let sequence = 0;
    for (let offset = 0; offset < input.bytes.byteLength; offset += CONTENT_CHUNK_MAX_BYTES) {
        peer.send(
            encodeContentChunkFrame({
                bytes: input.bytes.subarray(offset, offset + CONTENT_CHUNK_MAX_BYTES),
                requestId,
                sequence,
            }),
        );
        const acknowledged = decodeContentChunkAck(await peer.nextMessage());
        if (acknowledged.requestId !== requestId || acknowledged.sequence !== sequence) {
            throw new Error("The daemon did not acknowledge the uploaded content chunk");
        }
        sequence += 1;
    }
    peer.send(encodeContentCommitCommand({ kind: "content.commit", requestId, target: peer.target }));
    const available = await peer.nextMessage();
    if (
        decodeMessageKind(available) !== "content.available" ||
        decodeContentAvailableEvent(available).contentKey !== contentKey
    ) {
        throw new Error("The daemon did not store the uploaded content");
    }
    return {
        byteLength: input.bytes.byteLength,
        contentKey,
        kind: input.kind,
        mimeType: input.mediaType,
        name: input.name,
        uri: input.uri,
    };
}
