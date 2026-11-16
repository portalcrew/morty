import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { acpSession } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

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

    /** Changes the row of a saved session, and none when the session has no row. */
    readonly update = (row: AcpSessionRow): void => {
        this.#database.orm
            .update(acpSession)
            .set(row)
            .where(and(eq(acpSession.harness, row.harness), eq(acpSession.sessionId, row.sessionId)))
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
