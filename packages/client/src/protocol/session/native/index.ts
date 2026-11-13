import { z } from "zod";
import { DIRECTORY_PATH as directory, MAX_WORKSPACE_PATH_LENGTH } from "../../shared/directory.ts";
import { identifierStringSchema as identifier } from "../../shared/identifier.ts";
import { ProtocolMessageError } from "../../shared/message-codec.ts";
import {
    sessionElicitationRequestedEventSchema,
    sessionPermissionRequestedEventSchema,
} from "../interactions/index.ts";
import { sessionReadyEventSchema } from "../lifecycle/index.ts";
import { promptAttachmentSchema } from "../prompt/commands.ts";
import { sessionCapabilitiesSchema } from "../shared/index.ts";
import { nativeSessionTargetSchema } from "../shared/native-session-target.ts";

export const NATIVE_SESSION_REQUEST_KIND = "native.session.request";
export const NATIVE_SESSION_RESULT_KIND = "native.session.result";
export const NATIVE_SESSION_CANCEL_KIND = "native.session.cancel";

const envelope = {
    requestId: identifier,
};
const sessionInteractionSnapshotSchema = z
    .object({
        sessionGenerationId: identifier,
        throughPosition: z.string().regex(/^(0|[1-9][0-9]*)$/),
        interactions: z
            .array(
                z.discriminatedUnion("kind", [
                    sessionPermissionRequestedEventSchema,
                    sessionElicitationRequestedEventSchema,
                ]),
            )
            .readonly(),
    })
    .readonly();
export type SessionInteractionSnapshot = z.infer<typeof sessionInteractionSnapshotSchema>;

const activeTurnSnapshotSchema = z
    .object({
        commandId: identifier,
        epoch: identifier,
        interaction: z
            .discriminatedUnion("kind", [sessionPermissionRequestedEventSchema, sessionElicitationRequestedEventSchema])
            .nullable(),
        sequence: z.number().int().nonnegative(),
        // When the Computer recorded the start of this running turn.
        startedAt: z.iso.datetime({ offset: true }),
        state: z.literal("running"),
    })
    .readonly();

/**
 * Where one submitted command stands in the Computer's execution receipts. Only the
 * Computer that receives a command can say whether it arrived, so a client recovers an
 * unconfirmed submission from this rather than from Agent message identities.
 */
const commandDeliverySchema = z.discriminatedUnion("state", [
    // No receipt: the command has not arrived. A delayed submission may still arrive later.
    z.object({ state: z.literal("unknown") }).readonly(),
    // The Computer holds the command and has not finished it; it may be waiting or running.
    z.object({ state: z.literal("accepted") }).readonly(),
    z.object({ state: z.literal("completed"), stopReason: z.string().max(2_048) }).readonly(),
    z.object({ code: identifier, state: z.literal("failed") }).readonly(),
    // The command started, but the Computer no longer retains its result.
    z.object({ state: z.literal("expired") }).readonly(),
]);
export type CommandDelivery = z.infer<typeof commandDeliverySchema>;

/**
 * How the Session's most recent started command ended, from the Computer's execution receipts.
 * A client that missed the live outcome, after leaving, reloading or reconnecting, shows it from
 * this. While the Computer retains the live receipt, a failure carries its bounded client-facing
 * lifecycle message. After a Computer restart, it carries the sanitized
 * durable summary: Agent error text may quote user input and is not persisted in receipts.
 */
const lastTurnOutcomeSchema = z.discriminatedUnion("state", [
    z.object({ commandId: identifier, state: z.literal("completed"), stopReason: z.string().max(2_048) }).readonly(),
    z
        .object({
            code: identifier,
            commandId: identifier,
            message: z.string().min(1).max(500),
            state: z.literal("failed"),
        })
        .readonly(),
]);
export type LastTurnOutcome = z.infer<typeof lastTurnOutcomeSchema>;

const requestEnvelope = {
    ...envelope,
    kind: z.literal(NATIVE_SESSION_REQUEST_KIND),
};
// An Agent's own sessions on disk exist before any Morty Session does, so browsing them names the Agent and directory.
const agentDirectory = {
    ...requestEnvelope,
    harness: identifier,
    directory,
};

const nativeSessionRequestSchema = z.discriminatedUnion("action", [
    z
        .object({
            ...requestEnvelope,
            action: z.literal("active-turn"),
            // Asks the Computer for this command's delivery alongside the execution snapshot. It is not
            // named `commandId`, which routes a request as the command it names.
            deliveryCommandId: identifier.optional(),
            // The Computer reads the Session it holds for this target.
            target: nativeSessionTargetSchema,
        })
        .readonly(),
    z.object({ ...agentDirectory, action: z.literal("find"), sessionId: identifier }).readonly(),
    z
        .object({
            ...agentDirectory,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...agentDirectory,
            action: z.enum(["import", "fork"]),
            sessionId: identifier,
        })
        .readonly(),
]);
export type NativeSessionRequest = z.infer<typeof nativeSessionRequestSchema>;
const nativeSessionCommandSchema = z.discriminatedUnion("action", [
    z
        .object({
            ...requestEnvelope,
            action: z.literal("active-turn"),
            // Asks the Computer for this command's delivery alongside the execution snapshot. It is not
            // named `commandId`, which routes a request as the command it names.
            deliveryCommandId: identifier.optional(),
            // The Computer reads the Session it holds for this target.
            target: nativeSessionTargetSchema,
        })
        .readonly(),
    z.object({ ...agentDirectory, action: z.literal("find"), sessionId: identifier }).readonly(),
    z
        .object({
            ...agentDirectory,
            action: z.literal("list"),
            cursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...agentDirectory,
            action: z.enum(["import", "fork"]),
            sessionId: identifier,
        })
        .readonly(),
]);
export type NativeSessionCommand = z.infer<typeof nativeSessionCommandSchema>;

const nativeSessionEntrySchema = z
    .object({
        sessionId: identifier,
        title: z.string().max(500),
        directory,
        directoryLabel: z.string().min(1).max(MAX_WORKSPACE_PATH_LENGTH),
        updatedAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .readonly();
export type NativeSessionEntry = z.infer<typeof nativeSessionEntrySchema>;

const resultEnvelope = {
    ...envelope,
    kind: z.literal(NATIVE_SESSION_RESULT_KIND),
};
/** What reading a Session's execution answers: its running turn, queue, and last turn. */
export const activeTurnResultSchema = z
    .object({
        ...resultEnvelope,
        action: z.literal("active-turn"),
        target: nativeSessionTargetSchema,
        queued: z
            .array(
                z
                    .object({
                        commandId: identifier,
                        prompt: z.string().max(100_000),
                        attachments: z.array(promptAttachmentSchema).max(16).readonly(),
                    })
                    .readonly(),
            )
            .readonly(),
        turn: activeTurnSnapshotSchema.nullable(),
        // The whole execution read covers this prefix of the Session event log.
        executionPosition: z
            .object({
                sessionGenerationId: identifier,
                throughPosition: z.string().regex(/^(0|[1-9][0-9]*)$/),
            })
            .readonly(),
        // Null when this Computer has no retained Session for the requested identity.
        interactionState: sessionInteractionSnapshotSchema.nullable(),
        // Present only when the request named a command.
        command: commandDeliverySchema.optional(),
        // Absent while the last started command is running or none has started.
        lastTurn: lastTurnOutcomeSchema.optional(),
    })
    .readonly();
const nativeSessionResultSchema = z.discriminatedUnion("action", [
    activeTurnResultSchema,
    z
        .object({
            ...resultEnvelope,
            action: z.literal("find"),
            entry: nativeSessionEntrySchema,
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.literal("list"),
            capabilities: sessionCapabilitiesSchema,
            entries: z.array(nativeSessionEntrySchema).max(500).readonly(),
            nextCursor: identifier.nullable(),
        })
        .readonly(),
    z
        .object({
            ...resultEnvelope,
            action: z.enum(["import", "fork"]),
            target: nativeSessionTargetSchema,
            ready: sessionReadyEventSchema,
            title: z.string().max(500),
        })
        .readonly(),
]);
export type NativeSessionResult = z.infer<typeof nativeSessionResultSchema>;

const nativeSessionCancelSchema = z.object({ ...envelope, kind: z.literal(NATIVE_SESSION_CANCEL_KIND) }).readonly();
export type NativeSessionCancel = z.infer<typeof nativeSessionCancelSchema>;
function decode<T>(schema: z.ZodType<T>, encoded: string): T {
    try {
        const value: unknown = JSON.parse(encoded);
        return schema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid native session message", { cause });
    }
}

export const decodeNativeSessionCommand = (encoded: string): NativeSessionCommand =>
    decode(nativeSessionCommandSchema, encoded);
export const encodeNativeSessionCommand = (value: NativeSessionCommand): string =>
    JSON.stringify(nativeSessionCommandSchema.parse(value));
export const decodeNativeSessionRequest = (encoded: string): NativeSessionRequest =>
    decode(nativeSessionRequestSchema, encoded);
export const encodeNativeSessionRequest = (value: NativeSessionRequest): string =>
    JSON.stringify(nativeSessionRequestSchema.parse(value));
export const decodeNativeSessionResult = (encoded: string): NativeSessionResult =>
    decode(nativeSessionResultSchema, encoded);
export const encodeNativeSessionResult = (value: NativeSessionResult): string =>
    JSON.stringify(nativeSessionResultSchema.parse(value));
export const decodeNativeSessionCancel = (encoded: string): NativeSessionCancel =>
    decode(nativeSessionCancelSchema, encoded);
export const encodeNativeSessionCancel = (value: NativeSessionCancel): string =>
    JSON.stringify(nativeSessionCancelSchema.parse(value));
