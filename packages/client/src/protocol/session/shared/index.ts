import { z } from "zod";
import { DIRECTORY_PATH } from "../../shared/directory.ts";
import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodValue } from "../../shared/message-codec.ts";

export { DIRECTORY_PATH } from "../../shared/directory.ts";
export const SHORT_TEXT = z.string().max(500);

export const workspaceEntrySchema = z
    .object({
        directory: DIRECTORY_PATH,
        name: z.string().min(1).max(255),
    })
    .readonly();

export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

/**
 * How the Session's most recent started command ended, from the Computer's execution receipts.
 * A client that missed the live outcome, after leaving, reloading or reconnecting, shows it from
 * this. While the Computer retains the live receipt, a failure carries its bounded client-facing
 * lifecycle message. After a Computer restart, it carries the sanitized
 * durable summary: Agent error text may quote user input and is not persisted in receipts.
 */
export const lastTurnOutcomeSchema = z.discriminatedUnion("state", [
    z.object({ commandId: IDENTIFIER, state: z.literal("completed"), stopReason: z.string().max(2_048) }).readonly(),
    z
        .object({
            code: IDENTIFIER,
            commandId: IDENTIFIER,
            message: z.string().min(1).max(500),
            state: z.literal("failed"),
        })
        .readonly(),
]);
export type LastTurnOutcome = z.infer<typeof lastTurnOutcomeSchema>;

/**
 * `lastTurn`, whatever the kind: the latest turn that ended, while the Computer retains its outcome, even while a later
 * one runs. Its command identity tells a client that did not watch the Session whether another turn ended since.
 */
export const sessionStatusSchema = z.discriminatedUnion("kind", [
    z
        .object({
            kind: z.literal("idle"),
            lastTurn: lastTurnOutcomeSchema.optional(),
        })
        .readonly(),
    z
        .object({
            commandId: IDENTIFIER,
            kind: z.literal("working"),
            lastTurn: lastTurnOutcomeSchema.optional(),
        })
        .readonly(),
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionCapabilitiesSchema = z
    .object({
        audioPrompt: z.boolean(),
        closeSession: z.boolean(),
        deleteSession: z.boolean(),
        embeddedContextPrompt: z.boolean(),
        imagePrompt: z.boolean(),
        listSessions: z.boolean(),
        loadSession: z.boolean(),
        promptQueueing: z.boolean(),
        renameSession: z.boolean(),
        resumeSession: z.boolean(),
        steering: z.boolean(),
        unstableForkSession: z.boolean(),
    })
    .readonly();

export type SessionCapabilities = z.infer<typeof sessionCapabilitiesSchema>;

export const decodeSessionCapabilities = (value: unknown): SessionCapabilities =>
    decodeZodValue(value, sessionCapabilitiesSchema);

export const sessionCommandSchema = z
    .object({
        description: SHORT_TEXT,
        inputHint: z.string().max(255),
        name: z.string().min(1).max(128),
    })
    .readonly();

export type SessionCommand = z.infer<typeof sessionCommandSchema>;

export const configValueSchema = z
    .object({
        description: SHORT_TEXT,
        groupId: z.string().max(128),
        groupName: z.string().max(255),
        name: z.string().min(1).max(255),
        // ACP types a select value id as any string, and Agents use the empty
        // id to mean "the provider's own default" — no explicit setting is
        // sent. Refusing it would drop the whole option, so the id is bounded
        // by length alone.
        value: z.string().max(500),
    })
    .readonly();

export type SessionConfigValue = z.infer<typeof configValueSchema>;
