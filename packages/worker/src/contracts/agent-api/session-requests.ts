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
const historyInput = v.custom<ReturnType<typeof sessionHistoryPageLoadCodec.decodeRouting>>((value) => {
    try {
        sessionHistoryPageLoadCodec.decodeRouting(JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
});
const subscribeInput = v.custom<ReturnType<typeof sessionEventsSubscribeCommandCodec.decodeRouting>>((value) => {
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
const elicitationResponseInput = v.custom<ReturnType<typeof sessionElicitationRespondCommandCodec.decodeRouting>>(
    (value) => {
        try {
            sessionElicitationRespondCommandCodec.decodeRouting(JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    },
);
const permissionResponseInput = v.custom<ReturnType<typeof sessionPermissionRespondCommandCodec.decodeRouting>>(
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
