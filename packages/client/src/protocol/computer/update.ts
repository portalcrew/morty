import { z } from "zod";
import { encryptedMessageCodec } from "../shared/encrypted-message.ts";
import { type Identifier, isIdentifier, identifierStringSchema as routingIdentifier } from "../shared/identifier.ts";
import { decodeZodMessage as decodeRoutingZodMessage, encryptedFieldSchema } from "../shared/message-codec.ts";

const identifier = z.custom<Identifier>(isIdentifier);
// The Computer downloads the release before it answers, so its download deadline stays inside this budget, which
// stays inside the Worker's 120 s ceiling for any Computer request.
export const COMPUTER_UPDATE_TIMEOUT_MILLISECONDS = 110_000;
export const mortyReleaseVersionSchema = z
    .string()
    .max(32)
    .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);

function releaseParts(version: string): readonly number[] | null {
    return mortyReleaseVersionSchema.safeParse(version).success ? version.split(".").map(Number) : null;
}

/** False whenever either side is not a stable release, so an unknown version never asks for an update. */
export function isNewerMortyRelease(candidate: string, current: string): boolean {
    const next = releaseParts(candidate);
    const running = releaseParts(current);
    if (next === null || running === null) {
        return false;
    }
    for (const [index, part] of next.entries()) {
        const difference = part - (running[index] ?? 0);
        if (difference !== 0) {
            return difference > 0;
        }
    }
    return false;
}

const computerUpdateRequestSchema = z.strictObject({
    kind: z.literal("computer.update"),
    requestId: identifier,
    version: mortyReleaseVersionSchema,
});
const computerUpdateRestartingSchema = z.object({
    kind: z.literal("computer.update.restarting"),
    requestId: identifier,
    version: mortyReleaseVersionSchema,
});
export type ComputerUpdateRequest = Readonly<z.infer<typeof computerUpdateRequestSchema>>;
export type ComputerUpdateRestarting = Readonly<z.infer<typeof computerUpdateRestartingSchema>>;

const computerUpdateRequestPublicRoutingSchema = z.object({
    kind: z.literal("computer.update"),
    requestId: routingIdentifier,
});
const computerUpdateRequestRoutingSchema = computerUpdateRequestPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type ComputerUpdateRequestRouting = z.infer<typeof computerUpdateRequestRoutingSchema>;
export const computerUpdateRequestCodec = encryptedMessageCodec({
    kind: "computer.update",
    decode: (raw: string): ComputerUpdateRequest => computerUpdateRequestSchema.parse(JSON.parse(raw)),
    decodeRouting: (encoded: string) => decodeRoutingZodMessage(encoded, computerUpdateRequestRoutingSchema),
    publicRoutingSchema: computerUpdateRequestPublicRoutingSchema,
});

const computerUpdateRestartingPublicRoutingSchema = z.object({
    kind: z.literal("computer.update.restarting"),
    requestId: routingIdentifier,
});
const computerUpdateRestartingRoutingSchema = computerUpdateRestartingPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export const computerUpdateRestartingCodec = encryptedMessageCodec({
    kind: "computer.update.restarting",
    decode: (raw: string): ComputerUpdateRestarting => computerUpdateRestartingSchema.parse(JSON.parse(raw)),
    decodeRouting: (encoded: string) => decodeRoutingZodMessage(encoded, computerUpdateRestartingRoutingSchema),
    publicRoutingSchema: computerUpdateRestartingPublicRoutingSchema,
});
