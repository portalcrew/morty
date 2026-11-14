import { z } from "zod";
import { MAX_WORKSPACE_PATH_LENGTH } from "../../shared/directory.ts";
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
import { DIRECTORY_PATH, workspaceEntrySchema } from "../shared/index.ts";

export const WORKSPACE_LIST_KIND = "workspace.list";
export const WORKSPACE_ENTRIES_KIND = "workspace.entries";

const workspaceListCommandSchema = z
    .object({
        directory: DIRECTORY_PATH,
        kind: z.literal(WORKSPACE_LIST_KIND),
        requestId: IDENTIFIER,
        view: z.literal("metadata").optional(),
    })
    .readonly();

export type WorkspaceListCommand = z.infer<typeof workspaceListCommandSchema>;

const workspaceEntriesEventSchema = z
    .object({
        directory: DIRECTORY_PATH,
        directoryLabel: z.string().min(1).max(MAX_WORKSPACE_PATH_LENGTH),
        entries: z.array(workspaceEntrySchema).max(500).readonly(),
        kind: z.literal(WORKSPACE_ENTRIES_KIND),
        parentDirectory: z.string().max(MAX_WORKSPACE_PATH_LENGTH),
        requestId: IDENTIFIER,
    })
    .readonly();

export type WorkspaceEntriesEvent = z.infer<typeof workspaceEntriesEventSchema>;

export const decodeWorkspaceListCommand = (encoded: string): WorkspaceListCommand =>
    decode(encoded, workspaceListCommandSchema);
export const encodeWorkspaceListCommand = (message: WorkspaceListCommand): string =>
    encode(message, workspaceListCommandSchema);
const decodeWorkspaceEntriesEvent = (encoded: string): WorkspaceEntriesEvent =>
    decode(encoded, workspaceEntriesEventSchema);

const workspaceListCommandPublicRoutingSchema = z.object({
    kind: z.literal(WORKSPACE_LIST_KIND),
    requestId: routingIdentifier,
});
const workspaceListCommandRoutingSchema = workspaceListCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type WorkspaceListCommandRouting = z.infer<typeof workspaceListCommandRoutingSchema>;
const decodeWorkspaceListCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, workspaceListCommandRoutingSchema);
export const workspaceListCommandCodec = encryptedMessageCodec({
    kind: WORKSPACE_LIST_KIND,
    decode: decodeWorkspaceListCommand,
    decodeRouting: decodeWorkspaceListCommandRouting,
    publicRoutingSchema: workspaceListCommandPublicRoutingSchema,
});

const workspaceEntriesEventPublicRoutingSchema = z.object({
    kind: z.literal(WORKSPACE_ENTRIES_KIND),
    requestId: routingIdentifier,
});
const workspaceEntriesEventRoutingSchema = workspaceEntriesEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeWorkspaceEntriesEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, workspaceEntriesEventRoutingSchema);
export const workspaceEntriesEventCodec = encryptedMessageCodec({
    kind: WORKSPACE_ENTRIES_KIND,
    decode: decodeWorkspaceEntriesEvent,
    decodeRouting: decodeWorkspaceEntriesEventRouting,
    publicRoutingSchema: workspaceEntriesEventPublicRoutingSchema,
});
