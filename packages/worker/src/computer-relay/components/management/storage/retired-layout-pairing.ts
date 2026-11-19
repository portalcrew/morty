import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { daemonCredential } from "../../../schema/computer-relay-do/index.ts";

/** The retired object must remain readable without running the current schema migrations against it. */
export function heldRetiredPairing(
    storage: DurableObjectStorage,
    credentialHashes: readonly [string, string],
): boolean {
    if (storage.kv.get("computer-account") === undefined) {
        return false;
    }
    if (
        !storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'daemon_credentials'").next()
            .value
    ) {
        return false;
    }
    return (
        drizzle(storage)
            .select({ generation: daemonCredential.generation })
            .from(daemonCredential)
            .where(inArray(daemonCredential.tokenHash, [...credentialHashes]))
            .limit(1)
            .get() !== undefined
    );
}
