import { nativeSessionKey } from "@morty-build/client/native-session";
import {
    isDirectoryPath,
    isIdentifier,
    MAX_PROMPT_ATTACHMENT_BYTES,
    type NativeSessionTarget,
} from "@morty-build/client/protocol";
import * as v from "valibot";

/**
 * Central management of every value the web application persists in browser
 * session storage. Business modules never touch `window.sessionStorage`
 * directly; they read and write through `centralSessionStorage` with an entry
 * registered here. Each entry owns its stored key name, its value schema, and
 * its encode/decode contract:
 *
 * - `decode` returns `null` for anything it cannot represent; callers treat
 *   that value as absent.
 * - `encode` failure skips the write entirely.
 */

export interface SessionStorageEntry<T> {
    readonly key: string;
    readonly schema: v.GenericSchema<T>;
    readonly encode: (value: T) => string;
    readonly decode: (raw: string) => T | null;
}

/** Entry with a fully custom encode/decode contract. */
function customSessionStorageEntry<T>(options: {
    readonly key: string;
    readonly schema: v.GenericSchema<T>;
    readonly encode: (value: T) => string;
    readonly decode: (raw: string) => T | null;
}): SessionStorageEntry<T> {
    return {
        key: options.key,
        schema: options.schema,
        encode: options.encode,
        decode: options.decode,
    };
}

export const centralSessionStorage = {
    /** Reads and decodes; null when absent, undecodable, or storage is unavailable. */
    read: <T>(entry: SessionStorageEntry<T>): T | null => {
        let raw: string | null;
        try {
            raw = window.sessionStorage.getItem(entry.key);
        } catch {
            return null;
        }
        return raw === null ? null : entry.decode(raw);
    },
    /** Removes the stored value. */
    remove: (entry: SessionStorageEntry<never> | { readonly key: string }): void => {
        try {
            window.sessionStorage.removeItem(entry.key);
        } catch {}
    },
    /** Encodes and stores; callers that require durability must handle false. */
    write: <T>(entry: SessionStorageEntry<T>, value: T): boolean => {
        try {
            window.sessionStorage.setItem(entry.key, entry.encode(value));
            return true;
        } catch {
            return false;
        }
    },
};

function scopedKey(prefix: string, ...parts: readonly string[]): string {
    return `${prefix}${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}

// ---------------------------------------------------------------------------
// Unsent message drafts
// ---------------------------------------------------------------------------

const messageDraftSchema = v.pipe(v.string(), v.maxLength(100_000));

/** Entry whose value is stored as the raw string itself. */
function stringSessionStorageEntry(options: {
    readonly key: string;
    readonly schema: v.GenericSchema<string>;
}): SessionStorageEntry<string> {
    return {
        key: options.key,
        schema: options.schema,
        encode: (value) => v.parse(options.schema, value),
        decode: (raw) => {
            const parsed = v.safeParse(options.schema, raw);
            return parsed.success ? parsed.output : null;
        },
    };
}

/** One-time confirmation carried across the existing access-ending page reload. */
export const accessEndedNoticeEntry = stringSessionStorageEntry({
    key: "morty:access-ended:v1",
    schema: v.literal("ended"),
});

export const accessEndedComputerEntry = stringSessionStorageEntry({
    key: "morty:access-ended-computer:v1",
    schema: v.pipe(v.string(), v.maxLength(256)),
});

const transferRedemptionSchema = v.pipe(
    v.object({
        code: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
        key: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
    }),
    v.readonly(),
);

/** The key naming this tab's redemption of a link; a retry or reload after a lost reply repeats that redemption. */
export const transferRedemptionEntry = customSessionStorageEntry({
    key: "morty:transfer-redemption:v1",
    schema: transferRedemptionSchema,
    encode: (value) => JSON.stringify(v.parse(transferRedemptionSchema, value)),
    decode: (raw) => {
        try {
            const parsed = v.safeParse(transferRedemptionSchema, JSON.parse(raw));
            return parsed.success ? parsed.output : null;
        } catch {
            return null;
        }
    },
});

/** Carries first-visit guidance from a successful native handoff to its session. */
export const sessionWelcomeEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): SessionStorageEntry<"pending"> => ({
    key: scopedKey("morty:session-welcome:v2:", computerId, nativeSessionKey(sessionTarget)),
    schema: v.literal("pending"),
    encode: (value) => v.parse(v.literal("pending"), value),
    decode: (raw) => (raw === "pending" ? "pending" : null),
});

export const newConversationDraftEntry = (computerId: string): SessionStorageEntry<string> =>
    stringSessionStorageEntry({
        key: scopedKey("morty:message-draft:new:v1:", computerId),
        schema: messageDraftSchema,
    });

export const sessionDraftEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): SessionStorageEntry<string> =>
    stringSessionStorageEntry({
        key: scopedKey("morty:message-draft:session:v2:", computerId, nativeSessionKey(sessionTarget)),
        schema: messageDraftSchema,
    });

/** A submitted message the Computer never took; a reload returns it to the Session's composer. */
export const sessionUnsentMessageEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): SessionStorageEntry<string> =>
    stringSessionStorageEntry({
        key: scopedKey("morty:unsent-message:session:v2:", computerId, nativeSessionKey(sessionTarget)),
        schema: messageDraftSchema,
    });

const elicitationFieldValueSchema = v.union([
    v.pipe(v.string(), v.maxLength(100_000)),
    v.boolean(),
    v.pipe(v.array(v.pipe(v.string(), v.maxLength(2_048))), v.maxLength(500), v.readonly()),
]);
const elicitationAnswerDraftsSchema = v.pipe(
    v.record(
        v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        v.pipe(v.record(v.pipe(v.string(), v.maxLength(256)), elicitationFieldValueSchema), v.readonly()),
    ),
    v.readonly(),
);

export type ElicitationAnswerDrafts = v.InferOutput<typeof elicitationAnswerDraftsSchema>;

/** Answers typed into the Agent's pending questions in a Session, by question; a reload returns them to the form. */
export const elicitationAnswerDraftsEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): SessionStorageEntry<ElicitationAnswerDrafts> =>
    customSessionStorageEntry({
        key: scopedKey("morty:elicitation-answers:v2:", computerId, nativeSessionKey(sessionTarget)),
        schema: elicitationAnswerDraftsSchema,
        encode: (value) => JSON.stringify(v.parse(elicitationAnswerDraftsSchema, value)),
        decode: (raw) => {
            try {
                const parsed = v.safeParse(elicitationAnswerDraftsSchema, JSON.parse(raw));
                return parsed.success ? parsed.output : null;
            } catch {
                return null;
            }
        },
    });

const agentQuestionChoicesSchema = v.pipe(
    v.record(
        v.pipe(v.string(), v.minLength(1), v.maxLength(2_048)),
        v.pipe(
            v.record(v.pipe(v.string(), v.regex(/^\d{1,4}$/u)), v.pipe(v.string(), v.maxLength(2_048))),
            v.readonly(),
        ),
    ),
    v.readonly(),
);

export type AgentQuestionChoicesByMessage = v.InferOutput<typeof agentQuestionChoicesSchema>;

/**
 * The suggested answers picked for the questions Agent messages ask in a Session, by message and then by question
 * position; returning to the Session or reloading keeps them until they are sent.
 */
export const agentQuestionChoicesEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): SessionStorageEntry<AgentQuestionChoicesByMessage> =>
    customSessionStorageEntry({
        key: scopedKey("morty:agent-question-choices:v2:", computerId, nativeSessionKey(sessionTarget)),
        schema: agentQuestionChoicesSchema,
        encode: (value) => JSON.stringify(v.parse(agentQuestionChoicesSchema, value)),
        decode: (raw) => {
            try {
                const parsed = v.safeParse(agentQuestionChoicesSchema, JSON.parse(raw));
                return parsed.success ? parsed.output : null;
            } catch {
                return null;
            }
        },
    });

const unsentFirstMessageSchema = v.pipe(
    v.object({
        commandId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        content: messageDraftSchema,
    }),
    v.readonly(),
);

const unsentFirstMessagesSchema = v.pipe(v.array(unsentFirstMessageSchema), v.maxLength(100), v.readonly());

export type UnsentFirstMessage = v.InferOutput<typeof unsentFirstMessageSchema>;

/**
 * The first messages whose Sessions do not exist yet, oldest first, one per message: several creations can be in
 * flight at once, and a reload returns every one of them to the new-conversation composer.
 */
export const newConversationUnsentMessagesEntry = (
    computerId: string,
): SessionStorageEntry<readonly UnsentFirstMessage[]> =>
    customSessionStorageEntry({
        key: scopedKey("morty:unsent-messages:new:v2:", computerId),
        schema: unsentFirstMessagesSchema,
        encode: (value) => JSON.stringify(v.parse(unsentFirstMessagesSchema, value)),
        decode: (raw) => {
            try {
                const parsed = v.safeParse(unsentFirstMessagesSchema, JSON.parse(raw));
                return parsed.success ? parsed.output : null;
            } catch {
                return null;
            }
        },
    });

const rememberedSessionSchema = v.pipe(
    v.object({
        target: v.object({ harness: v.custom<string>(isIdentifier), sessionId: v.custom<string>(isIdentifier) }),
        title: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
    }),
    v.readonly(),
);

export type RememberedSession = v.InferOutput<typeof rememberedSessionSchema>;

/** Display-only context for this tab, scoped to the authenticated identity; never grants access. */
export const rememberedSessionEntry = (identity: string): SessionStorageEntry<RememberedSession> =>
    customSessionStorageEntry({
        key: scopedKey("morty:remembered-session:v1:", identity),
        schema: rememberedSessionSchema,
        encode: (value) => JSON.stringify(v.parse(rememberedSessionSchema, value)),
        decode: (raw) => {
            try {
                const parsed = v.safeParse(rememberedSessionSchema, JSON.parse(raw));
                return parsed.success ? parsed.output : null;
            } catch {
                return null;
            }
        },
    });

const submissionIdentifier = v.custom<string>(isIdentifier);
const uploadedAttachmentSchema = v.strictObject({
    byteLength: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(MAX_PROMPT_ATTACHMENT_BYTES)),
    contentKey: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    kind: v.picklist(["image", "resource"]),
    mimeType: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    uri: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
});
const pendingRequestEntries = {
    harness: v.exactOptional(submissionIdentifier),
    directory: v.exactOptional(v.custom<string>(isDirectoryPath)),
    // Preserve the attempted request exactly; the receiving API owns prompt-size rejection.
    content: v.string(),
    attachments: v.pipe(v.array(uploadedAttachmentSchema), v.maxLength(16), v.readonly()),
    sessionConfigurations: v.exactOptional(
        v.pipe(
            v.array(
                v.variant("type", [
                    v.strictObject({
                        configId: submissionIdentifier,
                        type: v.literal("select"),
                        value: v.pipe(v.string(), v.maxLength(500)),
                    }),
                    v.strictObject({
                        booleanValue: v.boolean(),
                        configId: submissionIdentifier,
                        type: v.literal("boolean"),
                    }),
                ]),
            ),
            v.maxLength(100),
            v.readonly(),
        ),
    ),
};
const pendingSubmissionSchema = v.strictObject({
    commandId: submissionIdentifier,
    placement: v.picklist(["turn", "queue"]),
    request: v.strictObject(pendingRequestEntries),
});
export type SessionPendingSubmission = v.InferOutput<typeof pendingSubmissionSchema>;

/** The unconfirmed request is a historical intent, separate from the next editable draft. */
export const sessionPendingSubmissionEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): SessionStorageEntry<SessionPendingSubmission> =>
    customSessionStorageEntry({
        key: scopedKey("morty:pending-submission:v2:", computerId, nativeSessionKey(sessionTarget)),
        schema: pendingSubmissionSchema,
        encode: (value) => JSON.stringify(v.parse(pendingSubmissionSchema, value)),
        decode: (raw) => {
            try {
                const parsed = v.safeParse(pendingSubmissionSchema, JSON.parse(raw));
                return parsed.success ? parsed.output : null;
            } catch {
                return null;
            }
        },
    });

export class SessionStorageWriteError extends Error {
    readonly code = "pending_submission_storage_unavailable";
    constructor() {
        super("The message could not be saved for recovery. Allow browser storage or free some space, then retry.");
        this.name = "SessionStorageWriteError";
    }
}
