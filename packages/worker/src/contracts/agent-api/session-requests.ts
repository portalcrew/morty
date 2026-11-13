import { type Identifier, isIdentifier } from "@morty-build/client/protocol";
import * as v from "valibot";
import { PairingDirectoryError } from "../relay/pairing.ts";

// The request bodies of the operations every Session API offers on one Session. Each API states the Session in its own
// way and shapes its own response, but a request for the same operation means the same thing on every API. The
// limits mirror the Computer protocol's, so a request the Computer would refuse fails before any Computer round trip.

const identifier = v.custom<Identifier>(isIdentifier);

/** A Turn submission apart from its attachments, which an API may state in more than one representation. */
const turnSubmissionEntries = {
    content: v.pipe(v.string(), v.maxLength(100_000)),
    disposition: v.optional(v.picklist(["append", "steer"]), "append"),
    idempotencyKey: v.pipe(
        identifier,
        v.description(
            "Persist before sending. Resend the same key to retry the same intended turn; a new key submits another turn.",
        ),
    ),
    sessionConfigurations: v.optional(v.pipe(v.array(v.unknown()), v.maxLength(100)), []),
    // Only a steering submission names the Turn it joins; the Computer protocol refuses a target on an appended one.
    targetCommandId: v.optional(identifier),
};

const turnAttachmentsSchema = v.pipe(v.array(v.unknown()), v.maxLength(16));

export const turnSubmissionRequest = v.strictObject({ ...turnSubmissionEntries, attachments: turnAttachmentsSchema });

export const turnSteerRequest = v.strictObject({ disposition: v.literal("steer") });

export const sessionConfigurationRequest = v.strictObject({
    booleanValue: v.boolean(),
    configId: identifier,
    expectedConfigurationRevision: identifier,
    value: v.pipe(v.string(), v.maxLength(500)),
    valueType: v.picklist(["select", "boolean"]),
});

export const sessionRenameRequest = v.strictObject({
    title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
});

export const interactionResponseRequest = v.variant("kind", [
    v.strictObject({
        kind: v.literal("permission"),
        optionId: v.pipe(v.string(), v.maxLength(255)),
        outcome: v.picklist(["cancelled", "selected"]),
        responderId: identifier,
    }),
    v.strictObject({
        action: v.picklist(["accept", "cancel", "decline"]),
        content: v.pipe(v.string(), v.maxLength(100_000)),
        kind: v.literal("elicitation"),
        responderId: identifier,
    }),
]);

/** Decodes a Session request body; a body the operation does not accept is the caller's error. */
export function decodeSessionRequest<TSchema extends v.GenericSchema>(
    schema: TSchema,
    value: unknown,
): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, value);
    if (!result.success) {
        throw new PairingDirectoryError("invalid_request", "The Session request is invalid", {
            cause: new v.ValiError(result.issues),
        });
    }
    return result.output;
}
