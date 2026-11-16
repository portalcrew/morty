import { count, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { replayClaim, replayClock } from "../../schema/computer-replay-ledger/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const CLOCK_ROW = 0;

const clockRowSchema = z.object({ latestAt: z.number().int().safe().nonnegative() });
const countRowSchema = z.object({ claims: z.number().int().nonnegative() });

export class ReplayLedgerTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    readonly transaction = <Result>(operation: () => Result): Result => this.#database.transaction(operation);

    readonly latestAdmission = (): number => {
        const row = this.#database.orm
            .select({ latestAt: replayClock.latestAt })
            .from(replayClock)
            .where(eq(replayClock.id, CLOCK_ROW))
            .get();
        return row === undefined ? 0 : clockRowSchema.parse(row).latestAt;
    };

    readonly forgetExpired = (now: number): void => {
        this.#database.orm.delete(replayClaim).where(lte(replayClaim.expiresAt, now)).run();
    };

    readonly holds = (fingerprint: string): boolean =>
        this.#database.orm
            .select({ fingerprint: replayClaim.fingerprint })
            .from(replayClaim)
            .where(eq(replayClaim.fingerprint, fingerprint))
            .get() !== undefined;

    readonly size = (): number =>
        countRowSchema.parse(this.#database.orm.select({ claims: count() }).from(replayClaim).get()).claims;

    readonly admit = (fingerprint: string, expiresAt: number, now: number): void => {
        this.#database.orm.insert(replayClaim).values({ fingerprint, expiresAt }).run();
        this.#database.orm
            .insert(replayClock)
            .values({ id: CLOCK_ROW, latestAt: now })
            .onConflictDoUpdate({ target: replayClock.id, set: { latestAt: now } })
            .run();
    };

    readonly close = (): void => this.#database.close();
}
