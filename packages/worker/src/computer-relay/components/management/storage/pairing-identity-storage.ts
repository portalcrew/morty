import { and, eq, inArray } from "drizzle-orm";
import type { ComputerIdentityCredential } from "../../../../contracts/relay/pairing-identity.ts";
import { relayDrizzle } from "../../../../infra/drizzle-database.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import { computerPairing, daemonCredential } from "../../../schema/computer-relay-do/index.ts";
import { activeGeneration } from "./computer-generation.ts";

/** Whether this computer's storage holds the credential: an active daemon credential, or a pairing code it issued. */
export async function credentialMatches(
    database: DurableObjectDatabase,
    credential: ComputerIdentityCredential,
    signal: AbortSignal,
): Promise<boolean> {
    const orm = relayDrizzle(database, signal);
    switch (credential.kind) {
        case "daemon": {
            const rows = await orm
                .select({ generation: daemonCredential.generation })
                .from(daemonCredential)
                .where(
                    and(
                        eq(daemonCredential.tokenHash, credential.tokenHash),
                        inArray(daemonCredential.generation, activeGeneration()),
                    ),
                )
                .limit(1);
            return rows.length === 1;
        }
        case "pairing-code": {
            const rows = await orm
                .select({ generation: computerPairing.generation })
                .from(computerPairing)
                .where(eq(computerPairing.pairingCodeHash, credential.codeHash))
                .limit(1);
            return rows.length === 1;
        }
    }
}
