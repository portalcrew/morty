import { z } from "zod";
import { identifierStringSchema } from "../shared/identifier.ts";
import { decodeZodMessage, encodeZodMessage } from "../shared/message-codec.ts";

/** A Computer acknowledges one authenticated upload chunk to its owning Worker operation. */
export const CONTENT_CHUNK_ACK_KIND = "content.chunk.ack";
const contentChunkAckSchema = z
    .strictObject({
        kind: z.literal(CONTENT_CHUNK_ACK_KIND),
        requestId: identifierStringSchema,
        sequence: z.number().int().min(0).max(0xffff_ffff),
    })
    .readonly();
export type ContentChunkAck = z.infer<typeof contentChunkAckSchema>;
export const decodeContentChunkAck = (encoded: string): ContentChunkAck =>
    decodeZodMessage(encoded, contentChunkAckSchema);
export const encodeContentChunkAck = (message: ContentChunkAck): string =>
    encodeZodMessage(message, contentChunkAckSchema);
