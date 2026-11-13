import { z } from "zod";
import { encryptedMessageCodec } from "../shared/encrypted-message.ts";
import { identifierStringSchema } from "../shared/identifier.ts";
import { decodeZodMessage, encryptedFieldSchema } from "../shared/message-codec.ts";

export const COMPUTER_METADATA_CREDENTIAL_HEADER = "Morty-Metadata-Computer-Credential";
export const COMPUTER_METADATA_SUCCESSOR_HEADER = "Morty-Metadata-Computer-Successor";

const resourceSchema = z.enum(["computer", "computers", "devices"]);
const computerSchema = z
    .object({
        computerId: identifierStringSchema,
        computerName: z.string().max(120),
        online: z.boolean(),
        agents: z.array(z.object({ harness: identifierStringSchema, label: z.string().max(80) }).readonly()).readonly(),
    })
    .readonly();
const deviceSchema = z
    .object({
        id: identifierStringSchema,
        joinedAt: z.iso.datetime(),
        label: z.string().max(80).nullable(),
        location: z
            .object({
                city: z.string().max(80).nullable(),
                country: z
                    .string()
                    .regex(/^[A-Z]{2}$/u)
                    .nullable(),
            })
            .readonly()
            .nullable(),
        addedBy: z
            .discriminatedUnion("kind", [
                z.object({ kind: z.literal("computer") }).readonly(),
                z.object({ kind: z.literal("device"), label: z.string().max(80).nullable() }).readonly(),
            ])
            .nullable(),
        accessExpiresAt: z.iso.datetime(),
    })
    .readonly();
const snapshotSchema = z.discriminatedUnion("resource", [
    z.object({ resource: z.literal("computer"), computer: computerSchema }).readonly(),
    z.object({ resource: z.literal("computers"), computers: z.array(computerSchema).readonly() }).readonly(),
    z.object({ resource: z.literal("devices"), devices: z.array(deviceSchema).readonly() }).readonly(),
]);
export type ComputerMetadataResource = z.infer<typeof resourceSchema>;
export type ComputerMetadataSnapshot = z.infer<typeof snapshotSchema>;
export const decodeComputerMetadataSnapshot = (encoded: string): ComputerMetadataSnapshot =>
    decodeZodMessage(encoded, snapshotSchema);

const requestSchema = z
    .strictObject({
        kind: z.literal("computer.metadata.read"),
        requestId: identifierStringSchema,
        resource: resourceSchema,
        credential: z.string().min(1).max(512),
    })
    .readonly();
const requestPublicRoutingSchema = z.object({
    kind: z.literal("computer.metadata.read"),
    requestId: identifierStringSchema,
});
const requestRoutingSchema = requestPublicRoutingSchema.extend({ encrypted: encryptedFieldSchema }).strict();
export type ComputerMetadataRequest = z.infer<typeof requestSchema>;
export type ComputerMetadataRequestRouting = z.infer<typeof requestRoutingSchema>;
export const decodeComputerMetadataRequest = (encoded: string): ComputerMetadataRequest =>
    decodeZodMessage(encoded, requestSchema);
export const computerMetadataRequestCodec = encryptedMessageCodec({
    kind: "computer.metadata.read",
    decode: decodeComputerMetadataRequest,
    decodeRouting: (encoded: string) => decodeZodMessage(encoded, requestRoutingSchema),
    publicRoutingSchema: requestPublicRoutingSchema,
});

const resultSchema = z
    .strictObject({
        kind: z.literal("computer.metadata.result"),
        requestId: identifierStringSchema,
        result: snapshotSchema,
    })
    .readonly();
const resultPublicRoutingSchema = z.object({
    kind: z.literal("computer.metadata.result"),
    requestId: identifierStringSchema,
});
const resultRoutingSchema = resultPublicRoutingSchema.extend({ encrypted: encryptedFieldSchema }).strict();
export const computerMetadataResultCodec = encryptedMessageCodec({
    kind: "computer.metadata.result",
    decode: (encoded: string) => decodeZodMessage(encoded, resultSchema),
    decodeRouting: (encoded: string) => decodeZodMessage(encoded, resultRoutingSchema),
    publicRoutingSchema: resultPublicRoutingSchema,
});
