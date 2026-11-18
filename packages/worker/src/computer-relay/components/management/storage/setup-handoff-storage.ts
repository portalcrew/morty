import { and, eq, gt, lte } from "drizzle-orm";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import { setupHandoff } from "../../../schema/computer-relay-do/index.ts";

export class SetupHandoffStorage {
    readonly #database: DurableObjectDatabase;

    constructor(database: DurableObjectDatabase) {
        this.#database = database;
    }

    /**
     * Keeps the first sealed handoff staged under a lookup id. Repeating that exact staging returns the same expiry, so
     * a retry after a lost reply is safe; different contents under the same id are a conflict.
     */
    readonly stage = (
        handoff: { readonly lookupId: string; readonly sealed: string; readonly expiresAt: number },
        now: number,
        signal: AbortSignal,
    ): { readonly kind: "staged"; readonly expiresAt: number } | { readonly kind: "conflict" } => {
        const database = this.#database.orm;
        this.#database.batch(
            [
                database.delete(setupHandoff).where(lte(setupHandoff.expiresAt, now)),
                database.insert(setupHandoff).values(handoff).onConflictDoNothing({ target: setupHandoff.lookupId }),
            ],
            signal,
        );
        const staged = database
            .select({ sealed: setupHandoff.sealed, expiresAt: setupHandoff.expiresAt })
            .from(setupHandoff)
            .where(eq(setupHandoff.lookupId, handoff.lookupId))
            .get();
        return staged?.sealed === handoff.sealed
            ? { kind: "staged", expiresAt: staged.expiresAt }
            : { kind: "conflict" };
    };

    readonly read = (lookupId: string, now: number, signal: AbortSignal): string | null => {
        signal.throwIfAborted();
        return (
            this.#database.orm
                .select({ sealed: setupHandoff.sealed })
                .from(setupHandoff)
                .where(and(eq(setupHandoff.lookupId, lookupId), gt(setupHandoff.expiresAt, now)))
                .get()?.sealed ?? null
        );
    };
}
