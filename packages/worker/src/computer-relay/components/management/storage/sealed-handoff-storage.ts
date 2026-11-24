import { and, eq, gt, lte } from "drizzle-orm";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import { sealedHandoff } from "../../../schema/computer-relay-do/index.ts";

export class SealedHandoffStorage {
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
                database.delete(sealedHandoff).where(lte(sealedHandoff.expiresAt, now)),
                database.insert(sealedHandoff).values(handoff).onConflictDoNothing({ target: sealedHandoff.lookupId }),
            ],
            signal,
        );
        const staged = database
            .select({ sealed: sealedHandoff.sealed, expiresAt: sealedHandoff.expiresAt })
            .from(sealedHandoff)
            .where(eq(sealedHandoff.lookupId, handoff.lookupId))
            .get();
        return staged?.sealed === handoff.sealed
            ? { kind: "staged", expiresAt: staged.expiresAt }
            : { kind: "conflict" };
    };

    readonly read = (lookupId: string, now: number, signal: AbortSignal): string | null => {
        signal.throwIfAborted();
        return (
            this.#database.orm
                .select({ sealed: sealedHandoff.sealed })
                .from(sealedHandoff)
                .where(and(eq(sealedHandoff.lookupId, lookupId), gt(sealedHandoff.expiresAt, now)))
                .get()?.sealed ?? null
        );
    };
}
