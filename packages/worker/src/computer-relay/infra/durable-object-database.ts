import { drizzle } from "drizzle-orm/durable-sqlite";
import * as schema from "../schema/computer-relay-do/index.ts";
import { migrateComputerStorage } from "./migrate-computer-storage.ts";

interface Mutation {
    readonly run: () => unknown;
}

/** Native SQLite for the owning computer; a batch commits as one synchronous transaction. */
export class DurableObjectDatabase {
    readonly #storage: DurableObjectStorage;
    readonly orm;

    constructor(storage: DurableObjectStorage) {
        migrateComputerStorage(storage);
        this.#storage = storage;
        this.orm = drizzle(storage, { schema });
    }

    readonly run = (query: Mutation, signal: AbortSignal) => {
        signal.throwIfAborted();
        query.run();
        const { changes } = this.#storage.sql.exec<{ changes: number }>("SELECT changes() AS changes").one();
        return { meta: { changes } };
    };

    readonly batch = (queries: readonly Mutation[], signal: AbortSignal) => {
        signal.throwIfAborted();
        return this.#storage.transactionSync(() => queries.map((query) => this.run(query, signal)));
    };
}
