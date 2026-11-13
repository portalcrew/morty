import type { PayloadDecryptor, PayloadEncryptor } from "@morty-build/client";
import { contentChunkCodec, decodeContentChunkFrame, encodeContentChunkFrame } from "@morty-build/client/protocol";

/** Translates file-transfer frames at the test peer's plaintext protocol boundary. */
export function encryptedContentFrames(encryption: PayloadEncryptor & PayloadDecryptor, signal: AbortSignal) {
    return {
        encode: async (frame: Uint8Array): Promise<Uint8Array> =>
            await contentChunkCodec.encode(decodeContentChunkFrame(frame), encryption, signal),
        decode: async (frame: Uint8Array): Promise<Uint8Array> =>
            encodeContentChunkFrame(await contentChunkCodec.decode(frame, encryption, signal)),
    };
}
