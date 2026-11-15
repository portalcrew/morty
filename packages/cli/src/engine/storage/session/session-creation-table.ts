import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { sessionCreation } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const receiptSchema = z
    .object({
        operationId: z.string(),
        requestHash: z.string(),
        harness: z.string(),
        sessionId: z.string(),
    })
    .readonly();

/** A finished creation: the request it ran and the Session it created. */
export interface SessionCreationReceipt {
    readonly requestHash: string;
    readonly target: NativeSessionTarget;
}

/** The receipts of finished creations, which answer a retry of the same operation. */
export class SessionCreationTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    readonly read = (operationId: string): SessionCreationReceipt | undefined => {
        const row = this.#database.orm
            .select()
            .from(sessionCreation)
            .where(eq(sessionCreation.operationId, operationId))
            .get();
        if (row === undefined) {
            return undefined;
        }
        const receipt = receiptSchema.parse(row);
        return {
            requestHash: receipt.requestHash,
            target: { harness: receipt.harness, sessionId: receipt.sessionId },
        };
    };

    readonly record = (operationId: string, requestHash: string, target: NativeSessionTarget): void => {
        this.#database.orm
            .insert(sessionCreation)
            .values({ operationId, requestHash, harness: target.harness, sessionId: target.sessionId })
            .run();
    };
}
