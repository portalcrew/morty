import { z } from "zod";
import { identifierStringSchema } from "../../shared/identifier.ts";

/**
 * A point in a Session's ordered log. A live event or execution read of the same generation at or after it reflects
 * what the Computer reported there; positions of different generations do not order.
 */
export const sessionLogPositionSchema = z
    .object({
        sessionGenerationId: identifierStringSchema,
        throughPosition: z.string().regex(/^(0|[1-9][0-9]*)$/),
    })
    .readonly();

export type SessionLogPosition = z.infer<typeof sessionLogPositionSchema>;

const admittedStandings = [
    z.object({ state: z.literal("queued") }).readonly(),
    z.object({ state: z.literal("running"), startedAt: z.iso.datetime({ offset: true }) }).readonly(),
    // The command ended, whether or not it started; the Session's log tells how.
    z.object({ state: z.literal("settled") }).readonly(),
] as const;

/** Where a command the Computer admitted stands once it entered the queue, started, or ended. */
export const admittedCommandStandingSchema = z.discriminatedUnion("state", [...admittedStandings]);

export type AdmittedCommandStanding = z.infer<typeof admittedCommandStandingSchema>;

/**
 * Where any command stands for the Computer. `unknown`: it holds no receipt, so the command has not arrived, though a
 * delayed submission still may. `preparing`: it received the command, which neither waits in the queue nor started.
 */
export const commandStandingSchema = z.discriminatedUnion("state", [
    z.object({ state: z.literal("unknown") }).readonly(),
    z.object({ state: z.literal("preparing") }).readonly(),
    ...admittedStandings,
]);

export type CommandStanding = z.infer<typeof commandStandingSchema>;
