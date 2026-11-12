import { applyDurableObjectMigrations } from "../../infra/durable-object-migrations.ts";
import { computerDurableObjectMigrations } from "../generated/computer-relay-do-migrations.ts";

export function migrateComputerStorage(storage: DurableObjectStorage): void {
    applyDurableObjectMigrations(storage, computerDurableObjectMigrations);
}
