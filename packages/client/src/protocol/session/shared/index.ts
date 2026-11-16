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

export const sessionStatusSchema = z.discriminatedUnion("kind", [
    z
        .object({
            kind: z.literal("idle"),
            /**
             * Present when the Session's most recent started command failed, while the Computer retains its receipt, so
             * a client that did not watch it can still show the Session failed until another command starts. It
             * carries what the execution's `lastTurn` reports for that failure.
             */
            failedTurn: z
                .object({ code: IDENTIFIER, commandId: IDENTIFIER, message: z.string().min(1).max(500) })
                .readonly()
                .optional(),
        })
        .readonly(),
    z
        .object({
            commandId: IDENTIFIER,
            kind: z.literal("working"),
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
