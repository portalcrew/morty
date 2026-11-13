import { z } from "zod";
import { encryptedMessageCodec } from "../../shared/encrypted-message.ts";
import {
    identifierStringSchema as IDENTIFIER,
    identifierStringSchema as routingIdentifier,
} from "../../shared/identifier.ts";
import {
    decodeZodMessage as decode,
    decodeZodMessage as decodeRoutingZodMessage,
    encodeZodMessage as encode,
    encryptedFieldSchema,
} from "../../shared/message-codec.ts";
import {
    nativeSessionTargetSchema,
    nativeSessionTargetSchema as routingTarget,
} from "../shared/native-session-target.ts";

export const SESSION_RENAME_KIND = "session.rename";
export const SESSION_RENAMED_KIND = "session.renamed";

const sessionRenameCommandSchema = z
    .object({
        kind: z.literal(SESSION_RENAME_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
        title: z.string().min(1).max(500),
    })
    .readonly();

export type SessionRenameCommand = z.infer<typeof sessionRenameCommandSchema>;

const sessionRenamedEventSchema = z
    .object({
        kind: z.literal(SESSION_RENAMED_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
        title: z.string().min(1).max(500),
        updatedAt: z.string().max(128),
    })
    .readonly();

export type SessionRenamedEvent = z.infer<typeof sessionRenamedEventSchema>;

export const decodeSessionRenameCommand = (encoded: string): SessionRenameCommand =>
    decode(encoded, sessionRenameCommandSchema);
export const encodeSessionRenameCommand = (message: SessionRenameCommand): string =>
    encode(message, sessionRenameCommandSchema);
export const decodeSessionRenamedEvent = (encoded: string): SessionRenamedEvent =>
    decode(encoded, sessionRenamedEventSchema);
export const encodeSessionRenamedEvent = (message: SessionRenamedEvent): string =>
    encode(message, sessionRenamedEventSchema);

const sessionRenameCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_RENAME_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionRenameCommandRoutingSchema = sessionRenameCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionRenameCommandRouting = z.infer<typeof sessionRenameCommandRoutingSchema>;
const decodeSessionRenameCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionRenameCommandRoutingSchema);
export const sessionRenameCommandCodec = encryptedMessageCodec({
    kind: SESSION_RENAME_KIND,
    decode: decodeSessionRenameCommand,
    decodeRouting: decodeSessionRenameCommandRouting,
    publicRoutingSchema: sessionRenameCommandPublicRoutingSchema,
});

const sessionRenamedEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_RENAMED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionRenamedEventRoutingSchema = sessionRenamedEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionRenamedEventRouting = z.infer<typeof sessionRenamedEventRoutingSchema>;
const decodeSessionRenamedEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionRenamedEventRoutingSchema);
export const sessionRenamedEventCodec = encryptedMessageCodec({
    kind: SESSION_RENAMED_KIND,
    decode: decodeSessionRenamedEvent,
    decodeRouting: decodeSessionRenamedEventRouting,
    publicRoutingSchema: sessionRenamedEventPublicRoutingSchema,
});
