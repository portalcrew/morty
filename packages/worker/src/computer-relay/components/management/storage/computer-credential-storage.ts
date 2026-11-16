import { relayDrizzle } from "../../../../infra/drizzle-database.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import { activeGeneration } from "./computer-generation.ts";

export class ComputerCredentialStorage {
    readonly #database: DurableObjectDatabase;

    constructor(database: DurableObjectDatabase) {
        this.#database = database;
    }

    readonly readActiveGeneration = async (signal: AbortSignal): Promise<number | null> => {
        const active = activeGeneration().as("active_generation");
        const rows = await relayDrizzle(this.#database, signal)
            .select({ generation: active.generation })
            .from(active)
            .limit(1);
        return rows[0]?.generation ?? null;
    };
}
