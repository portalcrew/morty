import { eq } from "drizzle-orm";
import type { ComputerIdentityCredential } from "../../../../contracts/relay/pairing-identity.ts";
import { relayDrizzle } from "../../../../infra/drizzle-database.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import { computerPairing, daemonCredential } from "../../../schema/computer-relay-do/index.ts";
import { activeDaemonCredential } from "./computer-generation.ts";

export async function holdsDaemonCredential(
    database: DurableObjectDatabase,
    tokenHash: string,
    signal: AbortSignal,
): Promise<boolean> {
    const rows = await relayDrizzle(database, signal)
        .select({ generation: daemonCredential.generation })
        .from(daemonCredential)
        .where(activeDaemonCredential(tokenHash))
        .limit(1);
    return rows.length === 1;
}

export async function credentialMatches(
    database: DurableObjectDatabase,
    credential: ComputerIdentityCredential,
    signal: AbortSignal,
): Promise<boolean> {
    switch (credential.kind) {
        case "daemon":
            return await holdsDaemonCredential(database, credential.tokenHash, signal);
        case "pairing-code": {
            const rows = await relayDrizzle(database, signal)
                .select({ generation: computerPairing.generation })
                .from(computerPairing)
                .where(eq(computerPairing.pairingCodeHash, credential.codeHash))
                .limit(1);
            return rows.length === 1;
        }
    }
}
