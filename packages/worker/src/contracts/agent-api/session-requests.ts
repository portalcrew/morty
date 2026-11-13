import {
    type Identifier,
    isIdentifier,
    nativeSessionCommandCodec,
    sessionCancelBeforeStartCommandCodec,
    sessionCancelCommandCodec,
    sessionConfigReadCommandCodec,
    sessionConfigureCommandCodec,
    sessionElicitationRespondCommandCodec,
    sessionEventsSubscribeCommandCodec,
    sessionHistoryPageLoadCodec,
    sessionPermissionRespondCommandCodec,
    sessionPromptCommandCodec,
    sessionPromptDispositionCommandCodec,
    sessionRenameCommandCodec,
} from "@morty-build/client/protocol";
import * as v from "valibot";
import { PairingDirectoryError } from "../relay/pairing.ts";

// The request bodies of the operations every Session API offers on one Session. Each API states the Session in its own
// way and shapes its own response, but a request for the same operation means the same thing on every API. The
// limits mirror the Computer protocol's, so a request the Computer would refuse fails before any Computer round trip.

const identifier = v.custom<Identifier>(isIdentifier);
export const sessionIdentifier = identifier;

export const promptInput = v.custom<ReturnType<typeof sessionPromptCommandCodec.decodeRouting>>((value) => {
    try {
        sessionPromptCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
export const cancelInput = v.custom<ReturnType<typeof sessionCancelCommandCodec.decodeRouting>>((value) => {
    try {
        sessionCancelCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
export const withdrawInput = v.custom<ReturnType<typeof sessionCancelBeforeStartCommandCodec.decodeRouting>>(
    (value) => {
        try {
            sessionCancelBeforeStartCommandCodec.decodeRouting(JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    },
);
export const dispositionInput = v.custom<ReturnType<typeof sessionPromptDispositionCommandCodec.decodeRouting>>(
    (value) => {
        try {
            sessionPromptDispositionCommandCodec.decodeRouting(JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    },
);
export const configureInput = v.custom<ReturnType<typeof sessionConfigureCommandCodec.decodeRouting>>((value) => {
    try {
        sessionConfigureCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
export const renameInput = v.custom<ReturnType<typeof sessionRenameCommandCodec.decodeRouting>>((value) => {
    try {
        sessionRenameCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
export const configReadInput = v.custom<ReturnType<typeof sessionConfigReadCommandCodec.decodeRouting>>((value) => {
    try {
        sessionConfigReadCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
export const historyInput = v.custom<ReturnType<typeof sessionHistoryPageLoadCodec.decodeRouting>>((value) => {
    try {
        sessionHistoryPageLoadCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
export const subscribeInput = v.custom<ReturnType<typeof sessionEventsSubscribeCommandCodec.decodeRouting>>((value) => {
    try {
        sessionEventsSubscribeCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
export const eventsInput = v.union([historyInput, subscribeInput]);
export const activeTurnInput = v.custom<ReturnType<typeof nativeSessionCommandCodec.decodeRouting>>((value) => {
    try {
        nativeSessionCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
export const elicitationResponseInput = v.custom<
    ReturnType<typeof sessionElicitationRespondCommandCodec.decodeRouting>
>((value) => {
    try {
        sessionElicitationRespondCommandCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
export const permissionResponseInput = v.custom<ReturnType<typeof sessionPermissionRespondCommandCodec.decodeRouting>>(
    (value) => {
        try {
            sessionPermissionRespondCommandCodec.decodeRouting(JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    },
);
export const encryptedInteractionResponseInput = v.union([elicitationResponseInput, permissionResponseInput]);

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

export const sessionConfigurationRequest = v.variant("type", [
    v.strictObject({
        configId: identifier,
        expectedConfigurationRevision: identifier,
        type: v.literal("select"),
        value: v.pipe(v.string(), v.maxLength(500)),
    }),
    v.strictObject({
        booleanValue: v.boolean(),
        configId: identifier,
        expectedConfigurationRevision: identifier,
        type: v.literal("boolean"),
    }),
]);

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
