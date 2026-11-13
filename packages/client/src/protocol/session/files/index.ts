import { z } from "zod";
import type { PayloadDecryptor, PayloadEncryptor } from "../../../encryption.ts";
import { encryptedMessageCodec } from "../../shared/encrypted-message.ts";
import {
    identifierStringSchema as IDENTIFIER,
    isIdentifier,
    identifierStringSchema as routingIdentifier,
} from "../../shared/identifier.ts";
import {
    decodeZodMessage as decode,
    decodeZodMessage as decodeRoutingZodMessage,
    encodeZodMessage as encode,
    encryptedFieldSchema,
    ProtocolMessageError,
} from "../../shared/message-codec.ts";
import {
    nativeSessionTargetSchema,
    nativeSessionTargetSchema as routingTarget,
} from "../shared/native-session-target.ts";

export const FILE_READ_KIND = "file.read";
export const FILE_BEGIN_KIND = "file.begin";
export const FILE_END_KIND = "file.end";
export const FILE_FAILED_KIND = "file.failed";
export const CONTENT_WRITE_KIND = "content.write";
export const CONTENT_COMMIT_KIND = "content.commit";
export const CONTENT_READY_KIND = "content.ready";
export const CONTENT_AVAILABLE_KIND = "content.available";

export const CONTENT_CHUNK_MAX_BYTES = 192 * 1024;
/** Maximum ASCII ciphertext body, including bounded encryption framing overhead. */
export const CONTENT_CHUNK_ENCRYPTED_MAX_BYTES = Math.ceil(((CONTENT_CHUNK_MAX_BYTES + 1024) * 4) / 3);
export const FILE_STREAM_CONTENT_TYPE = "application/vnd.morty.encrypted-file";
export const FILE_STREAM_MAX_MESSAGE_BYTES = 12 * 1024 * 1024 + 32 * 1024;
export const FILE_STREAM_MAX_CHUNK_BYTES = CONTENT_CHUNK_ENCRYPTED_MAX_BYTES + 255 + 9;
export const CONTENT_WRITE_MAX_BYTES = 32 * 1024 * 1024;
/** Maximum encrypted write, chunk and commit records for one bounded plaintext upload. */
export const CONTENT_UPLOAD_MAX_ENCODED_BYTES =
    Math.ceil(CONTENT_WRITE_MAX_BYTES / CONTENT_CHUNK_MAX_BYTES) * (FILE_STREAM_MAX_CHUNK_BYTES + 5) +
    2 * (FILE_STREAM_MAX_MESSAGE_BYTES + 5);
export const PROMPT_IMAGE_MAX_BYTES = 5_000_000;
const CONTENT_CHUNK_MAGIC = new Uint8Array([0x4d, 0x42, 0x43, 0x31]);
const CONTENT_CHUNK_HEADER_BYTES = CONTENT_CHUNK_MAGIC.byteLength + 1 + 4;

const fileReadCommandSchema = z
    .object({
        kind: z.literal(FILE_READ_KIND),
        maxBytes: z
            .number()
            .int()
            .positive()
            .max(128 * 1024 * 1024),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
        path: z.string().min(1).max(4_096),
    })
    .readonly();

export type FileReadCommand = z.infer<typeof fileReadCommandSchema>;

const fileBeginEventSchema = z
    .object({
        byteLength: z
            .number()
            .int()
            .positive()
            .max(128 * 1024 * 1024),
        kind: z.literal(FILE_BEGIN_KIND),
        mediaType: z.string().min(1).max(255),
        modifiedAt: z.iso.datetime({ offset: true }),
        name: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type FileBeginEvent = z.infer<typeof fileBeginEventSchema>;

const contentWriteCommandSchema = z
    .object({
        byteLength: z.number().int().positive().max(CONTENT_WRITE_MAX_BYTES),
        contentKey: z.string().regex(/^[a-f0-9]{64}$/u),
        contentKind: z.enum(["image", "resource"]),
        kind: z.literal(CONTENT_WRITE_KIND),
        mediaType: z.string().min(1).max(255),
        name: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type ContentWriteCommand = z.infer<typeof contentWriteCommandSchema>;

const contentCommitCommandSchema = z
    .object({
        kind: z.literal(CONTENT_COMMIT_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type ContentCommitCommand = z.infer<typeof contentCommitCommandSchema>;

const contentReadyEventSchema = z
    .object({
        kind: z.literal(CONTENT_READY_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type ContentReadyEvent = z.infer<typeof contentReadyEventSchema>;

const contentAvailableEventSchema = z
    .object({
        byteLength: z.number().int().positive().max(CONTENT_WRITE_MAX_BYTES),
        contentKey: z.string().regex(/^[a-f0-9]{64}$/u),
        kind: z.literal(CONTENT_AVAILABLE_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type ContentAvailableEvent = z.infer<typeof contentAvailableEventSchema>;

export interface ContentChunkFrame {
    readonly bytes: Uint8Array;
    readonly requestId: string;
    readonly sequence: number;
}

export type FileStreamRecord =
    | { readonly kind: "message"; readonly encoded: string }
    | { readonly kind: "chunk"; readonly encoded: Uint8Array };
export type FileStreamRecordDecode =
    | { readonly kind: "incomplete" }
    | { readonly kind: "record"; readonly record: FileStreamRecord; readonly byteLength: number };

const FILE_STREAM_HEADER_BYTES = 5;

/** Preserves each original native message or binary chunk across HTTP byte-stream boundaries. */
export function encodeFileStreamRecord(record: FileStreamRecord): Uint8Array {
    if (record.kind === "message" && record.encoded.length > FILE_STREAM_MAX_MESSAGE_BYTES) {
        throw new ProtocolMessageError("File stream message is too large");
    }
    const payload = record.kind === "message" ? new TextEncoder().encode(record.encoded) : record.encoded;
    const maximum = record.kind === "message" ? FILE_STREAM_MAX_MESSAGE_BYTES : FILE_STREAM_MAX_CHUNK_BYTES;
    if (payload.byteLength < 1 || payload.byteLength > maximum) {
        throw new ProtocolMessageError("Invalid file stream record length");
    }
    const encoded = new Uint8Array(FILE_STREAM_HEADER_BYTES + payload.byteLength);
    encoded[0] = record.kind === "message" ? 0 : 1;
    new DataView(encoded.buffer).setUint32(1, payload.byteLength);
    encoded.set(payload, FILE_STREAM_HEADER_BYTES);
    return encoded;
}

/** Examines the header and bounds its declared size before accepting a complete record. */
export function decodeFileStreamRecord(buffer: Uint8Array): FileStreamRecordDecode {
    if (buffer.byteLength < FILE_STREAM_HEADER_BYTES) {
        return { kind: "incomplete" };
    }
    const tag = buffer[0];
    if (tag !== 0 && tag !== 1) {
        throw new ProtocolMessageError("Invalid file stream record type");
    }
    const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(1);
    const maximum = tag === 0 ? FILE_STREAM_MAX_MESSAGE_BYTES : FILE_STREAM_MAX_CHUNK_BYTES;
    if (length < 1 || length > maximum) {
        throw new ProtocolMessageError("Invalid file stream record length");
    }
    const byteLength = FILE_STREAM_HEADER_BYTES + length;
    if (buffer.byteLength < byteLength) {
        return { kind: "incomplete" };
    }
    const payload = buffer.slice(FILE_STREAM_HEADER_BYTES, byteLength);
    if (tag === 1) {
        return { kind: "record", record: { kind: "chunk", encoded: payload }, byteLength };
    }
    try {
        const encoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
        return { kind: "record", record: { kind: "message", encoded }, byteLength };
    } catch (cause) {
        throw new ProtocolMessageError("Invalid file stream message encoding", { cause });
    }
}

function binaryBytes(value: unknown): Uint8Array {
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error("Content chunk must be a binary WebSocket frame");
}

export function encodeContentChunkFrame(frame: ContentChunkFrame): Uint8Array {
    return encodeChunkFrame(frame, CONTENT_CHUNK_MAX_BYTES);
}

function encodeChunkFrame(frame: ContentChunkFrame, maximumBytes: number): Uint8Array {
    if (!isIdentifier(frame.requestId)) {
        throw new Error("Content chunk request identifier is invalid");
    }
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffff_ffff) {
        throw new Error("Content chunk sequence is invalid");
    }
    if (frame.bytes.byteLength < 1 || frame.bytes.byteLength > maximumBytes) {
        throw new Error("Content chunk size is invalid");
    }
    const requestId = new TextEncoder().encode(frame.requestId);
    if (requestId.byteLength > 255) {
        throw new Error("Content chunk request identifier is too long");
    }
    const encoded = new Uint8Array(CONTENT_CHUNK_HEADER_BYTES + requestId.byteLength + frame.bytes.byteLength);
    encoded.set(CONTENT_CHUNK_MAGIC, 0);
    encoded[CONTENT_CHUNK_MAGIC.byteLength] = requestId.byteLength;
    new DataView(encoded.buffer).setUint32(CONTENT_CHUNK_MAGIC.byteLength + 1, frame.sequence);
    encoded.set(requestId, CONTENT_CHUNK_HEADER_BYTES);
    encoded.set(frame.bytes, CONTENT_CHUNK_HEADER_BYTES + requestId.byteLength);
    return encoded;
}

export function decodeContentChunkFrame(value: unknown): ContentChunkFrame {
    return decodeChunkFrame(value, CONTENT_CHUNK_MAX_BYTES);
}

function decodeChunkFrame(value: unknown, maximumBytes: number): ContentChunkFrame {
    const encoded = binaryBytes(value);
    if (
        encoded.byteLength <= CONTENT_CHUNK_HEADER_BYTES ||
        !CONTENT_CHUNK_MAGIC.every((byte, index) => encoded[index] === byte)
    ) {
        throw new Error("Content chunk frame header is invalid");
    }
    const requestIdLength = encoded[CONTENT_CHUNK_MAGIC.byteLength] ?? 0;
    const payloadOffset = CONTENT_CHUNK_HEADER_BYTES + requestIdLength;
    if (requestIdLength < 1 || payloadOffset >= encoded.byteLength) {
        throw new Error("Content chunk frame length is invalid");
    }
    const requestId = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        encoded.subarray(CONTENT_CHUNK_HEADER_BYTES, payloadOffset),
    );
    const bytes = encoded.slice(payloadOffset);
    const sequence = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getUint32(
        CONTENT_CHUNK_MAGIC.byteLength + 1,
    );
    if (!isIdentifier(requestId) || bytes.byteLength > maximumBytes) {
        throw new Error("Content chunk frame is invalid");
    }
    return { bytes, requestId, sequence };
}

export interface ContentChunkRouting {
    readonly requestId: string;
    readonly sequence: number;
    readonly encrypted: Uint8Array;
}

function chunkAssociatedData(requestId: string, sequence: number): Uint8Array {
    const frame = encodeContentChunkFrame({ requestId, sequence, bytes: new Uint8Array([0]) });
    return frame.slice(0, -1);
}

function decodeEncryptedChunkRouting(value: unknown): ContentChunkRouting {
    try {
        const { requestId, sequence, bytes } = decodeChunkFrame(value, CONTENT_CHUNK_ENCRYPTED_MAX_BYTES);
        return { requestId, sequence, encrypted: bytes };
    } catch (cause) {
        if (cause instanceof ProtocolMessageError) {
            throw cause;
        }
        throw new ProtocolMessageError("Invalid encrypted content chunk", { cause });
    }
}

export const contentChunkCodec = {
    decodeRouting: decodeEncryptedChunkRouting,
    encode: async (frame: ContentChunkFrame, encryptor: PayloadEncryptor, signal: AbortSignal): Promise<Uint8Array> => {
        const { requestId, sequence } = frame;
        const bytes = new Uint8Array(frame.bytes);
        let associatedData: Uint8Array;
        try {
            encodeContentChunkFrame({ requestId, sequence, bytes });
            associatedData = chunkAssociatedData(requestId, sequence);
        } catch (cause) {
            throw new ProtocolMessageError("Invalid content chunk", { cause });
        }
        const encrypted = await encryptor.encrypt(bytes, associatedData, signal);
        if (!/^[A-Za-z0-9_-]+$/u.test(encrypted) || encrypted.length > CONTENT_CHUNK_ENCRYPTED_MAX_BYTES) {
            throw new ProtocolMessageError("Invalid encrypted content chunk");
        }
        return encodeChunkFrame(
            { requestId, sequence, bytes: new TextEncoder().encode(encrypted) },
            CONTENT_CHUNK_ENCRYPTED_MAX_BYTES,
        );
    },
    decode: async (value: unknown, decryptor: PayloadDecryptor, signal: AbortSignal): Promise<ContentChunkFrame> => {
        const { requestId, sequence, encrypted: ciphertext } = decodeEncryptedChunkRouting(value);
        let encrypted: string;
        try {
            encrypted = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(ciphertext);
        } catch (cause) {
            throw new ProtocolMessageError("Invalid encrypted content chunk", { cause });
        }
        if (!/^[A-Za-z0-9_-]+$/u.test(encrypted)) {
            throw new ProtocolMessageError("Invalid encrypted content chunk");
        }
        const bytes = await decryptor.decrypt(encrypted, chunkAssociatedData(requestId, sequence), signal);
        if (bytes.byteLength < 1 || bytes.byteLength > CONTENT_CHUNK_MAX_BYTES) {
            throw new ProtocolMessageError("Invalid content chunk size");
        }
        return { requestId, sequence, bytes };
    },
};

const fileEndEventSchema = z
    .object({
        kind: z.literal(FILE_END_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type FileEndEvent = z.infer<typeof fileEndEventSchema>;

const fileFailedEventSchema = z
    .object({
        code: IDENTIFIER,
        kind: z.literal(FILE_FAILED_KIND),
        message: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type FileFailedEvent = z.infer<typeof fileFailedEventSchema>;

export const decodeFileReadCommand = (encoded: string): FileReadCommand => decode(encoded, fileReadCommandSchema);
export const encodeFileReadCommand = (message: FileReadCommand): string => encode(message, fileReadCommandSchema);
export const decodeFileBeginEvent = (encoded: string): FileBeginEvent => decode(encoded, fileBeginEventSchema);
export const encodeFileBeginEvent = (message: FileBeginEvent): string => encode(message, fileBeginEventSchema);
export const decodeFileEndEvent = (encoded: string): FileEndEvent => decode(encoded, fileEndEventSchema);
export const encodeFileEndEvent = (message: FileEndEvent): string => encode(message, fileEndEventSchema);
export const decodeFileFailedEvent = (encoded: string): FileFailedEvent => decode(encoded, fileFailedEventSchema);
export const encodeFileFailedEvent = (message: FileFailedEvent): string => encode(message, fileFailedEventSchema);
export const decodeContentWriteCommand = (encoded: string): ContentWriteCommand =>
    decode(encoded, contentWriteCommandSchema);
export const encodeContentWriteCommand = (message: ContentWriteCommand): string =>
    encode(message, contentWriteCommandSchema);
export const decodeContentCommitCommand = (encoded: string): ContentCommitCommand =>
    decode(encoded, contentCommitCommandSchema);
export const encodeContentCommitCommand = (message: ContentCommitCommand): string =>
    encode(message, contentCommitCommandSchema);
export const decodeContentReadyEvent = (encoded: string): ContentReadyEvent => decode(encoded, contentReadyEventSchema);
export const encodeContentReadyEvent = (message: ContentReadyEvent): string => encode(message, contentReadyEventSchema);
export const decodeContentAvailableEvent = (encoded: string): ContentAvailableEvent =>
    decode(encoded, contentAvailableEventSchema);
export const encodeContentAvailableEvent = (message: ContentAvailableEvent): string =>
    encode(message, contentAvailableEventSchema);

// GET file reads have no private request body: these are the URL and routing fields.
const fileReadCommandRoutingSchema = fileReadCommandSchema.unwrap().strict();
export type FileReadCommandRouting = z.infer<typeof fileReadCommandRoutingSchema>;
const decodeFileReadCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, fileReadCommandRoutingSchema);
export const fileReadCommandCodec = Object.freeze({
    kind: FILE_READ_KIND,
    decodeRouting: decodeFileReadCommandRouting,
    encodeRouting: (message: FileReadCommandRouting): string =>
        JSON.stringify(decodeFileReadCommandRouting(JSON.stringify(message))),
    encode: async (message: unknown, _encryptor: PayloadEncryptor, signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        return JSON.stringify(decodeFileReadCommandRouting(JSON.stringify(message)));
    },
    decode: async (encoded: string, _decryptor: PayloadDecryptor, signal: AbortSignal): Promise<FileReadCommand> => {
        signal.throwIfAborted();
        return decodeFileReadCommandRouting(encoded);
    },
});

const contentWriteCommandPublicRoutingSchema = z.object({
    kind: z.literal(CONTENT_WRITE_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const contentWriteCommandRoutingSchema = contentWriteCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type ContentWriteCommandRouting = z.infer<typeof contentWriteCommandRoutingSchema>;
const decodeContentWriteCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, contentWriteCommandRoutingSchema);
export const contentWriteCommandCodec = encryptedMessageCodec({
    kind: CONTENT_WRITE_KIND,
    decode: decodeContentWriteCommand,
    decodeRouting: decodeContentWriteCommandRouting,
    publicRoutingSchema: contentWriteCommandPublicRoutingSchema,
});

const contentCommitCommandPublicRoutingSchema = z.object({
    kind: z.literal(CONTENT_COMMIT_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const contentCommitCommandRoutingSchema = contentCommitCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type ContentCommitCommandRouting = z.infer<typeof contentCommitCommandRoutingSchema>;
const decodeContentCommitCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, contentCommitCommandRoutingSchema);
export const contentCommitCommandCodec = encryptedMessageCodec({
    kind: CONTENT_COMMIT_KIND,
    decode: decodeContentCommitCommand,
    decodeRouting: decodeContentCommitCommandRouting,
    publicRoutingSchema: contentCommitCommandPublicRoutingSchema,
});

const fileBeginEventPublicRoutingSchema = z.object({
    kind: z.literal(FILE_BEGIN_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const fileBeginEventRoutingSchema = fileBeginEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type FileBeginEventRouting = z.infer<typeof fileBeginEventRoutingSchema>;
const decodeFileBeginEventRouting = (encoded: string) => decodeRoutingZodMessage(encoded, fileBeginEventRoutingSchema);
export const fileBeginEventCodec = encryptedMessageCodec({
    kind: FILE_BEGIN_KIND,
    decode: decodeFileBeginEvent,
    decodeRouting: decodeFileBeginEventRouting,
    publicRoutingSchema: fileBeginEventPublicRoutingSchema,
});

const fileEndEventPublicRoutingSchema = z.object({
    kind: z.literal(FILE_END_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const fileEndEventRoutingSchema = fileEndEventPublicRoutingSchema.extend({ encrypted: encryptedFieldSchema }).strict();
export type FileEndEventRouting = z.infer<typeof fileEndEventRoutingSchema>;
const decodeFileEndEventRouting = (encoded: string) => decodeRoutingZodMessage(encoded, fileEndEventRoutingSchema);
export const fileEndEventCodec = encryptedMessageCodec({
    kind: FILE_END_KIND,
    decode: decodeFileEndEvent,
    decodeRouting: decodeFileEndEventRouting,
    publicRoutingSchema: fileEndEventPublicRoutingSchema,
});

const fileFailedEventPublicRoutingSchema = z.object({
    kind: z.literal(FILE_FAILED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const fileFailedEventRoutingSchema = fileFailedEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type FileFailedEventRouting = z.infer<typeof fileFailedEventRoutingSchema>;
const decodeFileFailedEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, fileFailedEventRoutingSchema);
export const fileFailedEventCodec = encryptedMessageCodec({
    kind: FILE_FAILED_KIND,
    decode: decodeFileFailedEvent,
    decodeRouting: decodeFileFailedEventRouting,
    publicRoutingSchema: fileFailedEventPublicRoutingSchema,
});

const contentReadyEventPublicRoutingSchema = z.object({
    kind: z.literal(CONTENT_READY_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const contentReadyEventRoutingSchema = contentReadyEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type ContentReadyEventRouting = z.infer<typeof contentReadyEventRoutingSchema>;
const decodeContentReadyEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, contentReadyEventRoutingSchema);
export const contentReadyEventCodec = encryptedMessageCodec({
    kind: CONTENT_READY_KIND,
    decode: decodeContentReadyEvent,
    decodeRouting: decodeContentReadyEventRouting,
    publicRoutingSchema: contentReadyEventPublicRoutingSchema,
});

const contentAvailableEventPublicRoutingSchema = z.object({
    kind: z.literal(CONTENT_AVAILABLE_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const contentAvailableEventRoutingSchema = contentAvailableEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type ContentAvailableEventRouting = z.infer<typeof contentAvailableEventRoutingSchema>;
const decodeContentAvailableEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, contentAvailableEventRoutingSchema);
export const contentAvailableEventCodec = encryptedMessageCodec({
    kind: CONTENT_AVAILABLE_KIND,
    decode: decodeContentAvailableEvent,
    decodeRouting: decodeContentAvailableEventRouting,
    publicRoutingSchema: contentAvailableEventPublicRoutingSchema,
});
