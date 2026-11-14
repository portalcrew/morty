import { z } from "zod";
import { encryptedMessageCodec } from "../shared/encrypted-message.ts";
import { type Identifier, isIdentifier, identifierStringSchema as routingIdentifier } from "../shared/identifier.ts";
import { decodeZodMessage as decodeRoutingZodMessage, encryptedFieldSchema } from "../shared/message-codec.ts";

const identifier = z.custom<Identifier>(isIdentifier);
const computerDiagnosticsRequestSchema = z.object({
    kind: z.literal("computer.diagnostics.read"),
    requestId: identifier,
});
const computerDiagnosticsResultSchema = z
    .strictObject({
        kind: z.literal("computer.diagnostics.result"),
        requestId: identifier,
        truncated: z.boolean(),
        version: z.string().max(32),
        entries: z
            .array(z.record(z.string(), z.string().max(256)).readonly())
            .max(200)
            .readonly(),
    })
    .refine((value) => JSON.stringify(value).length <= 65_536, "Diagnostics exceed the report limit");
type ComputerDiagnosticsRequest = Readonly<z.infer<typeof computerDiagnosticsRequestSchema>>;
export type ComputerDiagnosticsResult = Readonly<z.infer<typeof computerDiagnosticsResultSchema>>;
const decodeComputerDiagnosticsRequest = (raw: string): ComputerDiagnosticsRequest =>
    computerDiagnosticsRequestSchema.parse(JSON.parse(raw));
export const decodeComputerDiagnosticsResult = (raw: string): ComputerDiagnosticsResult =>
    computerDiagnosticsResultSchema.parse(JSON.parse(raw));

const computerDiagnosticsRequestPublicRoutingSchema = z.object({
    kind: z.literal("computer.diagnostics.read"),
    requestId: routingIdentifier,
});
const computerDiagnosticsRequestRoutingSchema = computerDiagnosticsRequestPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type ComputerDiagnosticsRequestRouting = z.infer<typeof computerDiagnosticsRequestRoutingSchema>;
const decodeComputerDiagnosticsRequestRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, computerDiagnosticsRequestRoutingSchema);
export const computerDiagnosticsRequestCodec = encryptedMessageCodec({
    kind: "computer.diagnostics.read",
    decode: decodeComputerDiagnosticsRequest,
    decodeRouting: decodeComputerDiagnosticsRequestRouting,
    publicRoutingSchema: computerDiagnosticsRequestPublicRoutingSchema,
});

const computerDiagnosticsResultPublicRoutingSchema = z.object({
    kind: z.literal("computer.diagnostics.result"),
    requestId: routingIdentifier,
});
const computerDiagnosticsResultRoutingSchema = computerDiagnosticsResultPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeComputerDiagnosticsResultRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, computerDiagnosticsResultRoutingSchema);
export const computerDiagnosticsResultCodec = encryptedMessageCodec({
    kind: "computer.diagnostics.result",
    decode: decodeComputerDiagnosticsResult,
    decodeRouting: decodeComputerDiagnosticsResultRouting,
    publicRoutingSchema: computerDiagnosticsResultPublicRoutingSchema,
});
