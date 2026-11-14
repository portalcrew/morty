/** A committed migration of one Durable Object SQLite target, copied verbatim from its generated `.sql` file. */
export interface DurableObjectMigration {
    readonly name: string;
    readonly sql: string;
}

// The runner's own ledger; every application table comes from the target's committed migrations.
const LEDGER = "_durable_object_migrations";

/**
 * Brings a Durable Object's storage to its target schema. Each committed migration the ledger does not record is
 * applied in order and commits atomically with its ledger entry, so an interrupted upgrade resumes where it stopped.
 */
export function applyDurableObjectMigrations(
    storage: DurableObjectStorage,
    migrations: readonly DurableObjectMigration[],
): void {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at INTEGER NOT NULL
    ) STRICT`);
    const applied = new Set(
        storage.sql
            .exec(`SELECT name FROM ${LEDGER}`)
            .toArray()
            .map((row) => row["name"]),
    );
    for (const migration of migrations) {
        const name = migration.name;
        if (applied.has(name)) {
            continue;
        }
        storage.transactionSync(() => {
            storage.sql.exec(migration.sql);
            storage.sql.exec(`INSERT INTO ${LEDGER} (name, applied_at) VALUES (?, ?)`, name, Date.now());
        });
    }
}
