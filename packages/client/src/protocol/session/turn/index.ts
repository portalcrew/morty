import { z } from "zod";
import { identifierSchema } from "../../shared/identifier.ts";
import { decodeZodValue } from "../../shared/message-codec.ts";
import { sessionConfigurationSelectionsSchema } from "../configuration/index.ts";
import { nativeSessionTargetSchema } from "../shared/native-session-target.ts";

const timestampSchema = z.string().datetime({ offset: true });

const reconciliationSchema = z
    .object({
        detectedAt: timestampSchema,
        reason: z.literal("dispatch_indeterminate"),
    })
    .readonly();

const turnStateSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("queued") }).readonly(),
    z.object({ kind: z.literal("running"), startedAt: timestampSchema }).readonly(),
    z
        .object({
            kind: z.literal("indeterminate"),
            reconciliation: reconciliationSchema,
        })
        .readonly(),
]);

export type TurnState = z.infer<typeof turnStateSchema>;

const promptTurnRequestSchema = z
    .object({
        content: z.string().max(100_000),
        kind: z.literal("prompt"),
        sessionConfigurations: sessionConfigurationSelectionsSchema.default([]),
    })
    .readonly();

const turnIdentitySchema = z.object({
    acceptedAt: timestampSchema,
    idempotencyKey: identifierSchema,
    target: nativeSessionTargetSchema,
    turnId: identifierSchema,
});
/** The acknowledgement of a Turn submission. */
export const turnSchema = turnIdentitySchema
    .extend({ request: promptTurnRequestSchema, state: turnStateSchema })
    .readonly();

export type Turn = z.infer<typeof turnSchema>;

/** Validates the acknowledgement returned when Morty submits a prompt. */
export const decodeTurn = (value: unknown): Turn | null => {
    const decoded = turnSchema.safeParse(value);
    return decoded.success ? decoded.data : null;
};

/** What the Relay answers when it steered or withdrew a Turn: the Turn it acted on. */
const turnReferenceSchema = z.object({ turnId: identifierSchema }).readonly();

export type TurnReference = z.infer<typeof turnReferenceSchema>;

/** What the Relay answers when it stopped a Turn: the Turn, and `cancelled` or the Agent's stop reason. */
const turnCancellationSchema = z.object({ stopReason: z.string().max(255), turnId: identifierSchema }).readonly();

export type TurnCancellation = z.infer<typeof turnCancellationSchema>;

export const decodeTurnReference = (value: unknown): TurnReference => decodeZodValue(value, turnReferenceSchema);
export const decodeTurnCancellation = (value: unknown): TurnCancellation =>
    decodeZodValue(value, turnCancellationSchema);
