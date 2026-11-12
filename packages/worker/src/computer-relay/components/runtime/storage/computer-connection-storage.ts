import { and, eq, inArray, isNull } from "drizzle-orm";
import { DatabaseError } from "../../../../infra/sql-database.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import { computerConnection } from "../../../schema/computer-relay-do/index.ts";
import { activeGeneration } from "../../management/storage/computer-generation.ts";
import type {
    ComputerConnection,
    ComputerConnectionIdentity,
    LatestComputerConnection,
} from "../entity/computer-connection.ts";

const connectionFields = {
    computerId: computerConnection.computerId,
    connectionEpoch: computerConnection.connectionEpoch,
    generation: computerConnection.generation,
    connectedAt: computerConnection.connectedAt,
};

export class ComputerConnectionStorage {
    readonly #database: DurableObjectDatabase;

    constructor(database: DurableObjectDatabase) {
        this.#database = database;
    }

    /** The current connection: attached, and admitted under the generation that is still active. */
    readonly read = (): ComputerConnection | null =>
        this.#database.orm
            .select(connectionFields)
            .from(computerConnection)
            .where(
                and(
                    isNull(computerConnection.disconnectedAt),
                    inArray(computerConnection.generation, activeGeneration(computerConnection.computerId)),
                ),
            )
            .limit(1)
            .get() ?? null;

    readonly latest = (): LatestComputerConnection | null => {
        const row = this.#database.orm
            .select({ ...connectionFields, disconnectedAt: computerConnection.disconnectedAt })
            .from(computerConnection)
            .limit(1)
            .get();
        if (row === undefined) {
            return null;
        }
        const { disconnectedAt, ...connection } = row;
        return disconnectedAt === null
            ? { ...connection, kind: "connected" }
            : { ...connection, kind: "disconnected", disconnectedAt };
    };

    /** Makes `identity` the computer's latest connection, replacing the one before it. */
    readonly connect = (identity: ComputerConnectionIdentity, generation: number, now: number): void => {
        const connection = {
            ...identity,
            generation,
            connectedAt: now,
            disconnectedAt: null,
        };
        const result = this.#database.orm
            .insert(computerConnection)
            .values(connection)
            .onConflictDoUpdate({ target: computerConnection.computerId, set: connection })
            .returning({ computerId: computerConnection.computerId })
            .get();
        if (!result) {
            throw new DatabaseError("database_unavailable", "The computer connection could not be recorded");
        }
    };

    readonly disconnect = (identity: ComputerConnectionIdentity, now: number): void => {
        this.#database.orm
            .update(computerConnection)
            .set({ disconnectedAt: now })
            .where(
                and(
                    eq(computerConnection.computerId, identity.computerId),
                    eq(computerConnection.connectionEpoch, identity.connectionEpoch),
                    isNull(computerConnection.disconnectedAt),
                ),
            )
            .run();
    };
}
