import { decodeNativeSessionTarget, type NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { and, asc, desc, eq, inArray, lt, max } from "drizzle-orm";
import { z } from "zod";
import { command, commandOutcome } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

/** How many settled outcomes each Session keeps; older ones are dropped, never the fate of a command that ran. */
const OUTCOMES_PER_SESSION = 1_024;

/**
 * What became of a command. A settled command's outcome is the content-free terminal event it recorded, or null once
 * retention dropped it; a command that settled before it started without being cancelled is forgotten with its outcome.
 * `interrupted-before-start`: a Computer restart settled the command before it started.
 */
export type CommandFate =
    | { readonly kind: "pending" }
    | { readonly kind: "started"; readonly startedAt: string }
    | { readonly kind: "cancelled"; readonly outcome: string | null }
    | { readonly kind: "interrupted-before-start"; readonly outcome: string }
    | { readonly kind: "settled-before-start"; readonly outcome: string }
    | { readonly kind: "settled-after-start"; readonly startedAt: string; readonly outcome: string | null };

export type SettledFate = Extract<CommandFate, { readonly outcome: unknown }>["kind"];

export type LedgerCommand = Readonly<{
    commandId: string;
    target: NativeSessionTarget;
    commandHash: string;
    attemptId: string;
    admissionOrder: number;
    fate: CommandFate;
}>;

export type CommandIdentity = Readonly<{
    commandId: string;
    target: NativeSessionTarget;
    commandHash: string;
    attemptId: string;
}>;

const rowSchema = z
    .object({
        commandId: z.string(),
        harness: z.string(),
        sessionId: z.string(),
        commandHash: z.string(),
        attemptId: z.string(),
        admissionOrder: z.number().int().positive().safe(),
        fate: z.enum(command.fate.enumValues),
        startedAt: z.string().nullable(),
        outcome: z.string().nullable(),
    })
    .readonly();

const ofSession = (target: NativeSessionTarget) =>
    and(eq(command.harness, target.harness), eq(command.sessionId, target.sessionId));

function ledgerCommand({
    fate,
    startedAt,
    outcome,
    harness,
    sessionId,
    ...columns
}: z.infer<typeof rowSchema>): LedgerCommand {
    const identity = { ...columns, target: decodeNativeSessionTarget({ harness, sessionId }) };
    const invalid = (): never => {
        throw new Error("The command ledger holds an invalid row", { cause: { commandId: identity.commandId, fate } });
    };
    switch (fate) {
        case "pending":
            return outcome === null ? { ...identity, fate: { kind: fate } } : invalid();
        case "started":
            return startedAt !== null && outcome === null
                ? { ...identity, fate: { kind: fate, startedAt } }
                : invalid();
        case "cancelled":
            return { ...identity, fate: { kind: fate, outcome } };
        case "interrupted-before-start":
        case "settled-before-start":
            return outcome === null ? invalid() : { ...identity, fate: { kind: fate, outcome } };
        case "settled-after-start":
            return startedAt === null ? invalid() : { ...identity, fate: { kind: fate, startedAt, outcome } };
        default:
            return fate satisfies never;
    }
}

/**
 * Owns the command ledger: one row per admitted command, and the outcomes kept for each Session's latest settled
 * commands. Every transition is one transaction, so a command's identity, order, fate and outcome never disagree.
 */
export class CommandLedgerTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    readonly #select = () =>
        this.#database.orm
            .select({
                commandId: command.commandId,
                harness: command.harness,
                sessionId: command.sessionId,
                commandHash: command.commandHash,
                attemptId: command.attemptId,
                admissionOrder: command.admissionOrder,
                fate: command.fate,
                startedAt: command.startedAt,
                outcome: commandOutcome.outcome,
            })
            .from(command)
            .leftJoin(commandOutcome, eq(commandOutcome.commandId, command.commandId));

    readonly read = (commandId: string): LedgerCommand | undefined => {
        const row = this.#select().where(eq(command.commandId, commandId)).get();
        return row === undefined ? undefined : ledgerCommand(rowSchema.parse(row));
    };

    readonly session = (target: NativeSessionTarget): readonly LedgerCommand[] =>
        this.#select()
            .where(ofSession(target))
            .orderBy(asc(command.admissionOrder))
            .all()
            .map((row) => ledgerCommand(rowSchema.parse(row)));

    readonly all = (): readonly LedgerCommand[] =>
        this.#select()
            .orderBy(asc(command.admissionOrder))
            .all()
            .map((row) => ledgerCommand(rowSchema.parse(row)));

    readonly admit = (identity: CommandIdentity): void => {
        this.#database.transaction(() => this.#insertPending(identity));
    };

    /**
     * Admits again, after every other, a command a Computer restart interrupted before it started, replacing that
     * admission and its outcome. Fails when the identifier holds no such admission.
     */
    readonly readmitInterrupted = (identity: CommandIdentity): void => {
        this.#database.transaction(() => {
            const replaced = this.#database.orm
                .delete(command)
                .where(and(eq(command.commandId, identity.commandId), eq(command.fate, "interrupted-before-start")))
                .returning({ commandId: command.commandId })
                .get();
            if (replaced === undefined) {
                throw new Error("The command holds no interrupted admission", {
                    cause: { commandId: identity.commandId },
                });
            }
            this.#database.orm.delete(commandOutcome).where(eq(commandOutcome.commandId, replaced.commandId)).run();
            this.#insertPending(identity);
        });
    };

    readonly #insertPending = (identity: CommandIdentity): void => {
        this.#database.orm
            .insert(command)
            .values({
                commandId: identity.commandId,
                commandHash: identity.commandHash,
                attemptId: identity.attemptId,
                harness: identity.target.harness,
                sessionId: identity.target.sessionId,
                admissionOrder: this.#nextAdmissionOrder(),
                fate: "pending",
            })
            .run();
    };

    readonly start = (commandId: string, startedAt: string): void => {
        this.#database.orm
            .update(command)
            .set({ fate: "started", startedAt })
            .where(and(eq(command.commandId, commandId), eq(command.fate, "pending")))
            .run();
    };

    readonly settle = (commandId: string, fate: SettledFate, outcome: string): readonly string[] =>
        this.#database.transaction(() => {
            const settled = this.#database.orm
                .update(command)
                .set(fate === "settled-after-start" ? { fate } : { fate, startedAt: null })
                .where(and(eq(command.commandId, commandId), inArray(command.fate, ["pending", "started"])))
                .returning({ harness: command.harness, sessionId: command.sessionId })
                .get();
            if (settled === undefined) {
                return [];
            }
            this.#database.orm.insert(commandOutcome).values({ commandId, outcome }).run();
            return this.#dropOutcomes(decodeNativeSessionTarget(settled));
        });

    /** Admits an unseen command as already cancelled, so the identifier can never run. */
    readonly admitCancelled = (identity: CommandIdentity, outcome: string): readonly string[] =>
        this.#database.transaction(() => {
            this.#database.orm
                .insert(command)
                .values({
                    commandId: identity.commandId,
                    commandHash: identity.commandHash,
                    attemptId: identity.attemptId,
                    harness: identity.target.harness,
                    sessionId: identity.target.sessionId,
                    admissionOrder: this.#nextAdmissionOrder(),
                    fate: "cancelled",
                })
                .run();
            this.#database.orm.insert(commandOutcome).values({ commandId: identity.commandId, outcome }).run();
            return this.#dropOutcomes(identity.target);
        });

    readonly #nextAdmissionOrder = (): number =>
        (this.#database.orm
            .select({ latest: max(command.admissionOrder) })
            .from(command)
            .get()?.latest ?? 0) + 1;

    /** Keeps the outcomes of the Session's latest settled commands; a command that never started goes with its outcome. */
    readonly #dropOutcomes = (target: NativeSessionTarget): readonly string[] => {
        const boundary = this.#database.orm
            .select({ admissionOrder: command.admissionOrder })
            .from(command)
            .innerJoin(commandOutcome, eq(commandOutcome.commandId, command.commandId))
            .where(ofSession(target))
            .orderBy(desc(command.admissionOrder))
            .limit(1)
            .offset(OUTCOMES_PER_SESSION - 1)
            .get();
        if (boundary === undefined) {
            return [];
        }
        const dropped = this.#database.orm
            .select({ commandId: command.commandId, fate: command.fate })
            .from(command)
            .innerJoin(commandOutcome, eq(commandOutcome.commandId, command.commandId))
            .where(and(ofSession(target), lt(command.admissionOrder, boundary.admissionOrder)))
            .all();
        const commandIds = dropped.map((row) => row.commandId);
        if (commandIds.length > 0) {
            this.#database.orm.delete(commandOutcome).where(inArray(commandOutcome.commandId, commandIds)).run();
            this.#database.orm
                .delete(command)
                .where(
                    and(
                        inArray(command.commandId, commandIds),
                        inArray(command.fate, ["interrupted-before-start", "settled-before-start"]),
                    ),
                )
                .run();
        }
        return commandIds;
    };
}
