import { eq } from "drizzle-orm";
import { z } from "zod";
import { sessionCreation } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const receiptSchema = z
    .object({
        operationId: z.string(),
        requestHash: z.string(),
        resultJson: z.string(),
    })
    .readonly();

/** The receipts of finished creations, which answer a retry of the same operation. */
export class SessionCreationTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    /** A row without a result is left by a Runtime that recorded a creation before it finished: no creation finished. */
    readonly read = (operationId: string): z.infer<typeof receiptSchema> | undefined => {
        const row = this.#database.orm
            .select()
            .from(sessionCreation)
            .where(eq(sessionCreation.operationId, operationId))
            .get();
        return row === undefined || row.resultJson === null ? undefined : receiptSchema.parse(row);
    };

    readonly record = (operationId: string, requestHash: string, resultJson: string): void => {
        this.#database.orm
            .insert(sessionCreation)
            .values({ operationId, requestHash, resultJson })
            .onConflictDoUpdate({ target: sessionCreation.operationId, set: { requestHash, resultJson } })
            .run();
    };
}
