import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { acpSession } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

/** One saved session row. The list columns hold JSON text that the session record decodes. */
export interface AcpSessionRow {
    readonly harness: string;
    readonly configurations: string;
    readonly cwd: string;
    readonly sessionId: string;
    readonly prompted: boolean;
    readonly title: string;
    readonly updatedAt: string;
}

const acpSessionRowSchema = z.object({
    harness: z.string(),
    configurations: z.string(),
    cwd: z.string(),
    sessionId: z.string(),
    prompted: z.boolean(),
    title: z.string(),
    updatedAt: z.string(),
});

function decodeRow(value: unknown): AcpSessionRow {
    return acpSessionRowSchema.parse(value);
}

/** The saved session rows. Closing the table closes the database it shares with the position table. */
export class AcpSessionTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    readonly close = (): void => this.#database.close();

    readonly list = (): readonly AcpSessionRow[] =>
        this.#database.orm.select().from(acpSession).orderBy(desc(acpSession.updatedAt)).all().map(decodeRow);

    readonly read = (target: NativeSessionTarget): AcpSessionRow | undefined => {
        const row = this.#database.orm
            .select()
            .from(acpSession)
            .where(and(eq(acpSession.harness, target.harness), eq(acpSession.sessionId, target.sessionId)))
            .get();
        return row === undefined ? undefined : decodeRow(row);
    };

    readonly remove = (target: NativeSessionTarget): void => {
        this.#database.orm
            .delete(acpSession)
            .where(and(eq(acpSession.harness, target.harness), eq(acpSession.sessionId, target.sessionId)))
            .run();
    };

    readonly upsert = (row: AcpSessionRow): void => {
        this.#database.orm
            .insert(acpSession)
            .values(row)
            .onConflictDoUpdate({ target: [acpSession.harness, acpSession.sessionId], set: row })
            .run();
    };
}
