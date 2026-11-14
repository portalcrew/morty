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
import { sessionConfigOptionsSchema, sessionConfigurationSelectionsSchema } from "../configuration/index.ts";
import {
    DIRECTORY_PATH,
    sessionCapabilitiesSchema,
    sessionCommandSchema,
    sessionStatusSchema,
} from "../shared/index.ts";
import {
    nativeSessionTargetSchema,
    nativeSessionTargetSchema as routingTarget,
} from "../shared/native-session-target.ts";

export const SESSION_PREPARE_KIND = "session.prepare";
export const SESSION_CREATE_KIND = "session.create";
export const SESSION_READY_KIND = "session.ready";
export const SESSION_LIST_KIND = "session.list";
export const SESSION_LISTED_KIND = "session.listed";
export const SESSION_QUERY_KIND = "session.query";
export const SESSION_QUERIED_KIND = "session.queried";
export const SESSION_RESTORE_KIND = "session.restore";
export const SESSION_RESTORED_KIND = "session.restored";
export const SESSION_CLOSE_NOTICE_KIND = "session.close.notice";
export const SESSION_ARCHIVE_KIND = "session.archive";
export const SESSION_ARCHIVED_KIND = "session.archived";
/** Failure code of an operation on a Session the Computer is archiving. */
export const SESSION_CLOSED_ERROR_CODE = "session_closed";
export const SESSION_OPERATION_FAILED_KIND = "session.operation.failed";
export const SESSION_PROMPT_ACCEPTED_KIND = "session.prompt.accepted";

/** What the Computer records of a Session, apart from which Session it is. */
const sessionRecordFields = {
    directory: DIRECTORY_PATH,
    directoryLabel: z.string().min(1).max(MAX_WORKSPACE_PATH_LENGTH),
    prompted: z.boolean(),
    status: sessionStatusSchema,
    title: z.string().max(500),
    updatedAt: z.iso.datetime({ offset: true }),
};
const sessionRecordSchema = z.object(sessionRecordFields).readonly();

const sessionMetadataSchema = z.object({ ...sessionRecordFields, target: nativeSessionTargetSchema }).readonly();

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

const sessionListCommandSchema = z
    .object({
        kind: z.literal(SESSION_LIST_KIND),
        limit: z.number().int().positive().max(500),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionListCommand = z.infer<typeof sessionListCommandSchema>;

const sessionsListedEventSchema = z
    .object({
        entries: z.array(sessionMetadataSchema).max(500).readonly(),
        kind: z.literal(SESSION_LISTED_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionsListedEvent = z.infer<typeof sessionsListedEventSchema>;

const sessionQueryCommandSchema = z
    .object({
        kind: z.literal(SESSION_QUERY_KIND),
        requestId: IDENTIFIER,
        targets: z.array(nativeSessionTargetSchema).min(1).max(500).readonly(),
    })
    .readonly();

export type SessionQueryCommand = z.infer<typeof sessionQueryCommandSchema>;

const sessionsQueriedEventSchema = z
    .object({
        entries: z.array(sessionMetadataSchema).max(500).readonly(),
        kind: z.literal(SESSION_QUERIED_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionsQueriedEvent = z.infer<typeof sessionsQueriedEventSchema>;

const sessionRestoreCommandSchema = z
    .object({
        kind: z.literal(SESSION_RESTORE_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionRestoreCommand = z.infer<typeof sessionRestoreCommandSchema>;

/**
 * Removes a Session from the Sessions this Computer holds, which are Morty's directory of Sessions on the computer. The
 * Computer closes the Session if it is open, then forgets its record; the Agent's own history of the Session stays, so
 * opening it from the Agent's sessions brings it back. Archiving a Session the Computer does not hold succeeds: the
 * Session is absent afterwards, as asked, so a retry after a lost answer succeeds too.
 */
const sessionArchiveCommandSchema = z
    .object({
        kind: z.literal(SESSION_ARCHIVE_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionArchiveCommand = z.infer<typeof sessionArchiveCommandSchema>;

/** Opens an existing Session with the Agent and directory the Computer holds it with. */
const sessionPrepareCommandSchema = z
    .object({
        kind: z.literal(SESSION_PREPARE_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionPrepareCommand = z.infer<typeof sessionPrepareCommandSchema>;

const sessionCreateCommandSchema = z
    .object({
        kind: z.literal(SESSION_CREATE_KIND),
        requestId: IDENTIFIER,
        operationId: IDENTIFIER,
        harness: IDENTIFIER,
        directory: DIRECTORY_PATH,
        configurations: sessionConfigurationSelectionsSchema,
    })
    .readonly();

export type SessionCreateCommand = z.infer<typeof sessionCreateCommandSchema>;
const decodeSessionCreateCommand = (encoded: string): SessionCreateCommand =>
    decode(encoded, sessionCreateCommandSchema);
export const encodeSessionCreateCommand = (message: SessionCreateCommand): string =>
    encode(message, sessionCreateCommandSchema);

const runtimeTimingsSchema = z
    .array(
        z
            .object({
                durationMilliseconds: z.number().finite().nonnegative().max(120_000),
                name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
            })
            .readonly(),
    )
    .max(16)
    .readonly();

/** What a Session's preparation tells a client, apart from which Session and which request it answers. */
const sessionReadyFields = {
    agentName: z.string().max(255),
    agentVersion: z.string().max(128),
    capabilities: sessionCapabilitiesSchema,
    commands: z.array(sessionCommandSchema).max(500).readonly(),
    configOptions: sessionConfigOptionsSchema,
    configurationRevision: IDENTIFIER,
    directory: DIRECTORY_PATH,
    directoryLabel: z.string().min(1).max(MAX_WORKSPACE_PATH_LENGTH),
    restored: z.boolean(),
    runtimeTimings: runtimeTimingsSchema.optional(),
};
export const sessionReadyBodySchema = z.object(sessionReadyFields).readonly();
export type SessionReadyBody = z.infer<typeof sessionReadyBodySchema>;

const sessionReadyEventSchema = z
    .object({
        ...sessionReadyFields,
        kind: z.literal(SESSION_READY_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionReadyEvent = z.infer<typeof sessionReadyEventSchema>;

const sessionRestoredEventSchema = z
    .object({
        entry: sessionRecordSchema,
        target: nativeSessionTargetSchema,
        kind: z.literal(SESSION_RESTORED_KIND),
        ready: sessionReadyBodySchema,
        requestId: IDENTIFIER,
    })
    .readonly();

export type SessionRestoredEvent = z.infer<typeof sessionRestoredEventSchema>;

/** Answers `session.archive` once the Computer no longer holds the Session. */
const sessionArchivedEventSchema = z
    .object({
        kind: z.literal(SESSION_ARCHIVED_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionArchivedEvent = z.infer<typeof sessionArchivedEventSchema>;

/**
 * Tells every observer that the Computer is archiving a Session. Unlike `session.archived`, which answers one
 * `session.archive` request, a notice is not tied to a request, so it also reaches clients that did not ask.
 * `reason` is a sentence a client can show its user as is, such as "This Session was archived.".
 * Show it as plain text and don't branch on it: its wording can change between Computer versions.
 */
const sessionCloseNoticeEventSchema = z
    .object({
        kind: z.literal(SESSION_CLOSE_NOTICE_KIND),
        reason: z.string().min(1).max(500),
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionCloseNoticeEvent = z.infer<typeof sessionCloseNoticeEventSchema>;

const sessionOperationFailedEventSchema = z
    .object({
        code: IDENTIFIER,
        kind: z.literal(SESSION_OPERATION_FAILED_KIND),
        message: z.string().min(1).max(500),
        requestId: IDENTIFIER,
        runtimeTimings: runtimeTimingsSchema.optional(),
        target: nativeSessionTargetSchema.optional(),
    })
    .readonly();

export type SessionOperationFailedEvent = z.infer<typeof sessionOperationFailedEventSchema>;

/**
 * Answers a prompt: it entered the Session's queue, started running, or had already settled before it started (for
 * example when it was withdrawn, or when a retry finds it settled). `requestId` addresses the submission. A prompt
 * that failed before it started is answered by `session.operation.failed`.
 */
const sessionPromptAcceptedEventSchema = z
    .object({
        kind: z.literal(SESSION_PROMPT_ACCEPTED_KIND),
        requestId: IDENTIFIER,
        target: nativeSessionTargetSchema,
        state: z.enum(["queued", "running", "settled"]),
    })
    .readonly();

export type SessionPromptAcceptedEvent = z.infer<typeof sessionPromptAcceptedEventSchema>;

const decodeSessionListCommand = (encoded: string): SessionListCommand => decode(encoded, sessionListCommandSchema);
export const encodeSessionListCommand = (message: SessionListCommand): string =>
    encode(message, sessionListCommandSchema);
export const decodeSessionsListedEvent = (encoded: string): SessionsListedEvent =>
    decode(encoded, sessionsListedEventSchema);
const decodeSessionQueryCommand = (encoded: string): SessionQueryCommand => decode(encoded, sessionQueryCommandSchema);
export const encodeSessionQueryCommand = (message: SessionQueryCommand): string =>
    encode(message, sessionQueryCommandSchema);
export const decodeSessionsQueriedEvent = (encoded: string): SessionsQueriedEvent =>
    decode(encoded, sessionsQueriedEventSchema);
const decodeSessionRestoreCommand = (encoded: string): SessionRestoreCommand =>
    decode(encoded, sessionRestoreCommandSchema);
export const encodeSessionRestoreCommand = (message: SessionRestoreCommand): string =>
    encode(message, sessionRestoreCommandSchema);
export const decodeSessionRestoredEvent = (encoded: string): SessionRestoredEvent =>
    decode(encoded, sessionRestoredEventSchema);
const decodeSessionArchiveCommand = (encoded: string): SessionArchiveCommand =>
    decode(encoded, sessionArchiveCommandSchema);
export const encodeSessionArchiveCommand = (message: SessionArchiveCommand): string =>
    encode(message, sessionArchiveCommandSchema);
export const decodeSessionArchivedEvent = (encoded: string): SessionArchivedEvent =>
    decode(encoded, sessionArchivedEventSchema);
export const decodeSessionCloseNoticeEvent = (encoded: string): SessionCloseNoticeEvent =>
    decode(encoded, sessionCloseNoticeEventSchema);
const decodeSessionPrepareCommand = (encoded: string): SessionPrepareCommand =>
    decode(encoded, sessionPrepareCommandSchema);
export const encodeSessionPrepareCommand = (message: SessionPrepareCommand): string =>
    encode(message, sessionPrepareCommandSchema);
export const decodeSessionReadyEvent = (encoded: string): SessionReadyEvent => decode(encoded, sessionReadyEventSchema);
export const decodeSessionOperationFailedEvent = (encoded: string): SessionOperationFailedEvent =>
    decode(encoded, sessionOperationFailedEventSchema);
export const decodeSessionPromptAcceptedEvent = (encoded: string): SessionPromptAcceptedEvent =>
    decode(encoded, sessionPromptAcceptedEventSchema);
export const encodeSessionPromptAcceptedEvent = (message: SessionPromptAcceptedEvent): string =>
    encode(message, sessionPromptAcceptedEventSchema);

const sessionListCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_LIST_KIND),
    requestId: routingIdentifier,
});
const sessionListCommandRoutingSchema = sessionListCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionListCommandRouting = z.infer<typeof sessionListCommandRoutingSchema>;
const decodeSessionListCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionListCommandRoutingSchema);
export const sessionListCommandCodec = encryptedMessageCodec({
    kind: SESSION_LIST_KIND,
    decode: decodeSessionListCommand,
    decodeRouting: decodeSessionListCommandRouting,
    publicRoutingSchema: sessionListCommandPublicRoutingSchema,
});

const sessionQueryCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_QUERY_KIND),
    requestId: routingIdentifier,
});
const sessionQueryCommandRoutingSchema = sessionQueryCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionQueryCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionQueryCommandRoutingSchema);
export const sessionQueryCommandCodec = encryptedMessageCodec({
    kind: SESSION_QUERY_KIND,
    decode: decodeSessionQueryCommand,
    decodeRouting: decodeSessionQueryCommandRouting,
    publicRoutingSchema: sessionQueryCommandPublicRoutingSchema,
});

const sessionRestoreCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_RESTORE_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionRestoreCommandRoutingSchema = sessionRestoreCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionRestoreCommandRouting = z.infer<typeof sessionRestoreCommandRoutingSchema>;
const decodeSessionRestoreCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionRestoreCommandRoutingSchema);
export const sessionRestoreCommandCodec = encryptedMessageCodec({
    kind: SESSION_RESTORE_KIND,
    decode: decodeSessionRestoreCommand,
    decodeRouting: decodeSessionRestoreCommandRouting,
    publicRoutingSchema: sessionRestoreCommandPublicRoutingSchema,
});

const sessionArchiveCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_ARCHIVE_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionArchiveCommandRoutingSchema = sessionArchiveCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionArchiveCommandRouting = z.infer<typeof sessionArchiveCommandRoutingSchema>;
const decodeSessionArchiveCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionArchiveCommandRoutingSchema);
export const sessionArchiveCommandCodec = encryptedMessageCodec({
    kind: SESSION_ARCHIVE_KIND,
    decode: decodeSessionArchiveCommand,
    decodeRouting: decodeSessionArchiveCommandRouting,
    publicRoutingSchema: sessionArchiveCommandPublicRoutingSchema,
});

const sessionCreateCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_CREATE_KIND),
    requestId: routingIdentifier,
    harness: routingIdentifier,
    operationId: routingIdentifier,
});
const sessionCreateCommandRoutingSchema = sessionCreateCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionCreateCommandRouting = z.infer<typeof sessionCreateCommandRoutingSchema>;
const decodeSessionCreateCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionCreateCommandRoutingSchema);
export const sessionCreateCommandCodec = encryptedMessageCodec({
    kind: SESSION_CREATE_KIND,
    decode: decodeSessionCreateCommand,
    decodeRouting: decodeSessionCreateCommandRouting,
    publicRoutingSchema: sessionCreateCommandPublicRoutingSchema,
});

const sessionPrepareCommandPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_PREPARE_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionPrepareCommandRoutingSchema = sessionPrepareCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type SessionPrepareCommandRouting = z.infer<typeof sessionPrepareCommandRoutingSchema>;
const decodeSessionPrepareCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionPrepareCommandRoutingSchema);
export const sessionPrepareCommandCodec = encryptedMessageCodec({
    kind: SESSION_PREPARE_KIND,
    decode: decodeSessionPrepareCommand,
    decodeRouting: decodeSessionPrepareCommandRouting,
    publicRoutingSchema: sessionPrepareCommandPublicRoutingSchema,
});

const sessionArchivedEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_ARCHIVED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionArchivedEventRoutingSchema = sessionArchivedEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionArchivedEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionArchivedEventRoutingSchema);
export const sessionArchivedEventCodec = encryptedMessageCodec({
    kind: SESSION_ARCHIVED_KIND,
    decode: decodeSessionArchivedEvent,
    decodeRouting: decodeSessionArchivedEventRouting,
    publicRoutingSchema: sessionArchivedEventPublicRoutingSchema,
});

const sessionCloseNoticeEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_CLOSE_NOTICE_KIND),
    target: routingTarget,
});
const sessionCloseNoticeEventRoutingSchema = sessionCloseNoticeEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionCloseNoticeEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionCloseNoticeEventRoutingSchema);
export const sessionCloseNoticeEventCodec = encryptedMessageCodec({
    kind: SESSION_CLOSE_NOTICE_KIND,
    decode: decodeSessionCloseNoticeEvent,
    decodeRouting: decodeSessionCloseNoticeEventRouting,
    publicRoutingSchema: sessionCloseNoticeEventPublicRoutingSchema,
});

const sessionsListedEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_LISTED_KIND),
    requestId: routingIdentifier,
});
const sessionsListedEventRoutingSchema = sessionsListedEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionsListedEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionsListedEventRoutingSchema);
export const sessionsListedEventCodec = encryptedMessageCodec({
    kind: SESSION_LISTED_KIND,
    decode: decodeSessionsListedEvent,
    decodeRouting: decodeSessionsListedEventRouting,
    publicRoutingSchema: sessionsListedEventPublicRoutingSchema,
});

const sessionsQueriedEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_QUERIED_KIND),
    requestId: routingIdentifier,
});
const sessionsQueriedEventRoutingSchema = sessionsQueriedEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionsQueriedEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionsQueriedEventRoutingSchema);
export const sessionsQueriedEventCodec = encryptedMessageCodec({
    kind: SESSION_QUERIED_KIND,
    decode: decodeSessionsQueriedEvent,
    decodeRouting: decodeSessionsQueriedEventRouting,
    publicRoutingSchema: sessionsQueriedEventPublicRoutingSchema,
});

const sessionRestoredEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_RESTORED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionRestoredEventRoutingSchema = sessionRestoredEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionRestoredEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionRestoredEventRoutingSchema);
export const sessionRestoredEventCodec = encryptedMessageCodec({
    kind: SESSION_RESTORED_KIND,
    decode: decodeSessionRestoredEvent,
    decodeRouting: decodeSessionRestoredEventRouting,
    publicRoutingSchema: sessionRestoredEventPublicRoutingSchema,
});

const sessionOperationFailedEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_OPERATION_FAILED_KIND),
    requestId: routingIdentifier,
    target: routingTarget.optional(),
});
const sessionOperationFailedEventRoutingSchema = sessionOperationFailedEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionOperationFailedEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionOperationFailedEventRoutingSchema);
export const sessionOperationFailedEventCodec = encryptedMessageCodec({
    kind: SESSION_OPERATION_FAILED_KIND,
    decode: decodeSessionOperationFailedEvent,
    decodeRouting: decodeSessionOperationFailedEventRouting,
    publicRoutingSchema: sessionOperationFailedEventPublicRoutingSchema,
});

const sessionPromptAcceptedEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_PROMPT_ACCEPTED_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionPromptAcceptedEventRoutingSchema = sessionPromptAcceptedEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeSessionPromptAcceptedEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionPromptAcceptedEventRoutingSchema);
export const sessionPromptAcceptedEventCodec = encryptedMessageCodec({
    kind: SESSION_PROMPT_ACCEPTED_KIND,
    decode: decodeSessionPromptAcceptedEvent,
    decodeRouting: decodeSessionPromptAcceptedEventRouting,
    publicRoutingSchema: sessionPromptAcceptedEventPublicRoutingSchema,
});

const sessionReadyEventPublicRoutingSchema = z.object({
    kind: z.literal(SESSION_READY_KIND),
    requestId: routingIdentifier,
    target: routingTarget,
});
const sessionReadyEventRoutingSchema = sessionReadyEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export function lifecycleWireJsonSchemas() {
    return {
        listRequest: z.toJSONSchema(sessionListCommandRoutingSchema),
        createRequest: z.toJSONSchema(sessionCreateCommandRoutingSchema),
        prepareRequest: z.toJSONSchema(sessionPrepareCommandRoutingSchema),
        listedReply: z.toJSONSchema(sessionsListedEventRoutingSchema),
        readyReply: z.toJSONSchema(sessionReadyEventRoutingSchema),
        promptReply: z.toJSONSchema(sessionPromptAcceptedEventRoutingSchema),
        failureReply: z.toJSONSchema(sessionOperationFailedEventRoutingSchema),
    };
}
const decodeSessionReadyEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, sessionReadyEventRoutingSchema);
export const sessionReadyEventCodec = encryptedMessageCodec({
    kind: SESSION_READY_KIND,
    decode: decodeSessionReadyEvent,
    decodeRouting: decodeSessionReadyEventRouting,
    publicRoutingSchema: sessionReadyEventPublicRoutingSchema,
});
