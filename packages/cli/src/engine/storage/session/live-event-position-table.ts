import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { sessionLiveEventPositionAllocation } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const allocationRowSchema = z.object({ allocatedPosition: z.number().int().safe().nonnegative() });

const ofSession = (target: NativeSessionTarget) =>
    and(
        eq(sessionLiveEventPositionAllocation.harness, target.harness),
        eq(sessionLiveEventPositionAllocation.sessionId, target.sessionId),
    );

/** The highest live event position reserved for each session. */
export class LiveEventPositionTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    readonly transaction = <Result>(operation: () => Result): Result => this.#database.transaction(operation);

    readonly read = (target: NativeSessionTarget): number | undefined => {
        const persisted = this.#database.orm
            .select({ allocatedPosition: sessionLiveEventPositionAllocation.allocatedPosition })
            .from(sessionLiveEventPositionAllocation)
            .where(ofSession(target))
            .get();
        return persisted === undefined ? undefined : allocationRowSchema.parse(persisted).allocatedPosition;
    };

    readonly insert = (target: NativeSessionTarget, allocatedPosition: number): void => {
        this.#database.orm
            .insert(sessionLiveEventPositionAllocation)
            .values({ harness: target.harness, sessionId: target.sessionId, allocatedPosition })
            .run();
    };

    readonly update = (target: NativeSessionTarget, allocatedPosition: number): void => {
        this.#database.orm
            .update(sessionLiveEventPositionAllocation)
            .set({ allocatedPosition })
            .where(ofSession(target))
            .run();
    };
}
