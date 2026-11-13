import { z } from "zod";
import { identifierSchema } from "../../shared/identifier.ts";
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
