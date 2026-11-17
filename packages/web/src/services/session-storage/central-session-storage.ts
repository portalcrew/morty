import { nativeSessionKey } from "@portalcrew/morty-client/native-session";
import {
    isDirectoryPath,
    isIdentifier,
    MAX_PROMPT_ATTACHMENT_BYTES,
    type NativeSessionTarget,
} from "@portalcrew/morty-client/protocol";
import * as v from "valibot";
import { jsonStorageEntry, type StorageEntry, scopedKey, stringStorageEntry } from "../storage-entry.ts";

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

export const centralSessionStorage = {
    read: <T>(entry: StorageEntry<T>): T | null => {
        let raw: string | null;
        try {
            raw = window.sessionStorage.getItem(entry.key);
        } catch {
            return null;
        }
        return raw === null ? null : entry.decode(raw);
    },
    remove: (entry: StorageEntry<never> | { readonly key: string }): void => {
        try {
            window.sessionStorage.removeItem(entry.key);
        } catch {}
    },
    /** Encodes and stores; callers that require durability must handle false. */
    write: <T>(entry: StorageEntry<T>, value: T): boolean => {
        try {
            window.sessionStorage.setItem(entry.key, entry.encode(value));
            return true;
        } catch {
            return false;
        }
    },
};

const messageDraftSchema = v.pipe(v.string(), v.maxLength(100_000));

const browserDiagnosticSchema = v.object({
    at: v.pipe(v.string(), v.isoTimestamp()),
    component: v.picklist(["worker", "relay", "web"]),
    operation: v.pipe(v.string(), v.maxLength(80)),
    outcome: v.pipe(v.string(), v.maxLength(64)),
    requestId: v.pipe(v.string(), v.maxLength(64)),
    elapsedMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
    attempt: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export type BrowserDiagnostic = Readonly<v.InferOutput<typeof browserDiagnosticSchema>>;

export const BROWSER_DIAGNOSTICS_MAX_ENTRIES = 100;

// Kept for this tab only, so a refresh keeps the failure that prompted a report and closing the tab clears it.
export const browserDiagnosticsEntry = jsonStorageEntry({
    key: "morty:browser-diagnostics:v1",
    schema: v.object({
        entries: v.pipe(v.array(browserDiagnosticSchema), v.maxLength(BROWSER_DIAGNOSTICS_MAX_ENTRIES)),
        discarded: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
});

export const accessEndedEntry = jsonStorageEntry({
    key: "morty:access-ended:v2",
    schema: v.object({ computerName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)) }),
});

export function endedComputerName(name: string | undefined): string {
    return name === undefined || name === "" ? "the previous computer" : name;
}

const transferRedemptionSchema = v.pipe(
    v.object({
        code: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
        key: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
    }),
    v.readonly(),
);

export const transferRedemptionEntry = jsonStorageEntry({
    key: "morty:transfer-redemption:v1",
    schema: transferRedemptionSchema,
});

export const sessionWelcomeEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): StorageEntry<"pending"> => ({
    key: scopedKey("morty:session-welcome:v2:", computerId, nativeSessionKey(sessionTarget)),
    encode: (value) => v.parse(v.literal("pending"), value),
    decode: (raw) => (raw === "pending" ? "pending" : null),
});

const newConversationDraftSchema = v.pipe(
    v.object({
        key: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        text: messageDraftSchema,
    }),
    v.readonly(),
);

export type NewConversationDraft = v.InferOutput<typeof newConversationDraftSchema>;

/**
 * The New Session draft and its key, which names the Session creation sending it starts or continues. A first message
 * that returns to the draft brings its own key, so sending it again continues a creation the Computer may already have
 * completed instead of starting a second Session.
 */
export const newConversationDraftEntry = (computerId: string): StorageEntry<NewConversationDraft> =>
    jsonStorageEntry({
        key: scopedKey("morty:message-draft:new:v2:", computerId),
        schema: newConversationDraftSchema,
    });

export const sessionDraftEntry = (computerId: string, sessionTarget: NativeSessionTarget): StorageEntry<string> =>
    stringStorageEntry({
        key: scopedKey("morty:message-draft:session:v2:", computerId, nativeSessionKey(sessionTarget)),
        schema: messageDraftSchema,
    });

/** A submitted message the Computer never took; a reload returns it to the Session's composer. */
export const sessionUnsentMessageEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): StorageEntry<string> =>
    stringStorageEntry({
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

export const elicitationAnswerDraftsEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): StorageEntry<ElicitationAnswerDrafts> =>
    jsonStorageEntry({
        key: scopedKey("morty:elicitation-answers:v2:", computerId, nativeSessionKey(sessionTarget)),
        schema: elicitationAnswerDraftsSchema,
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

export const agentQuestionChoicesEntry = (
    computerId: string,
    sessionTarget: NativeSessionTarget,
): StorageEntry<AgentQuestionChoicesByMessage> =>
    jsonStorageEntry({
        key: scopedKey("morty:agent-question-choices:v2:", computerId, nativeSessionKey(sessionTarget)),
        schema: agentQuestionChoicesSchema,
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

export const newConversationUnsentMessagesEntry = (computerId: string): StorageEntry<readonly UnsentFirstMessage[]> =>
    jsonStorageEntry({
        key: scopedKey("morty:unsent-messages:new:v2:", computerId),
        schema: unsentFirstMessagesSchema,
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
export const rememberedSessionEntry = (identity: string): StorageEntry<RememberedSession> =>
    jsonStorageEntry({
        key: scopedKey("morty:remembered-session:v1:", identity),
        schema: rememberedSessionSchema,
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
): StorageEntry<SessionPendingSubmission> =>
    jsonStorageEntry({
        key: scopedKey("morty:pending-submission:v2:", computerId, nativeSessionKey(sessionTarget)),
        schema: pendingSubmissionSchema,
    });

export class SessionStorageWriteError extends Error {
    readonly code = "pending_submission_storage_unavailable";
    constructor() {
        super("The message could not be saved for recovery. Allow browser storage or free some space, then retry.");
        this.name = "SessionStorageWriteError";
    }
}
