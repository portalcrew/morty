import { and, count, eq, gt, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import type { AgentDescriptor } from "../../../../contracts/relay/pairing.ts";
import type {
    ComputerCredentialRotation,
    ComputerPairingDirectoryRow,
    ComputerPairingRow,
    PairingClaimRow,
} from "../../../../contracts/relay/pairing-records.ts";
import { type RelayDrizzleDatabase, relayDrizzle } from "../../../../infra/drizzle-database.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import {
    computerAgentCatalog,
    computerPairing,
    computerRegistration,
    computerRevocation,
    daemonCredential,
    retiredDaemonCredential,
} from "../../../schema/computer-relay-do/index.ts";
import { activeGeneration, currentGeneration } from "./computer-generation.ts";

const registrationFields = {
    computer_name: computerRegistration.computerName,
    workspace_name: computerRegistration.workspaceName,
};
interface CreateComputerPairing {
    readonly codeHash: string;
    readonly pollHash: string;
    readonly now: number;
    readonly expiresAt: number;
    readonly idempotencyKey: string;
}

const bound = <T>(value: T, name: string) => sql<T>`${value}`.as(name);

/**
 * The computer's pairing generations. Each transition records a fact of one generation; pairing the computer again
 * starts a new generation instead of changing an earlier one.
 */
export class ComputerDirectoryStorage {
    readonly #database: DurableObjectDatabase;

    constructor(database: DurableObjectDatabase) {
        this.#database = database;
    }

    private readonly generationQuery = (database: RelayDrizzleDatabase) =>
        database
            .select({
                poll_token_hash: computerPairing.pollTokenHash,
                expires_at: computerPairing.expiresAt,
                revoked_at: computerRevocation.revokedAt,
                registration: registrationFields,
                agents: computerAgentCatalog.agents,
            })
            .from(computerPairing)
            .leftJoin(computerRegistration, eq(computerRegistration.generation, computerPairing.generation))
            .leftJoin(computerAgentCatalog, eq(computerAgentCatalog.generation, computerPairing.generation))
            .leftJoin(computerRevocation, eq(computerRevocation.generation, computerPairing.generation));

    readonly readPairingCode = async (codeHash: string, signal: AbortSignal): Promise<PairingClaimRow | null> => {
        const rows = await this.generationQuery(relayDrizzle(this.#database, signal))
            .where(eq(computerPairing.pairingCodeHash, codeHash))
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readCurrentPairing = async (signal: AbortSignal): Promise<PairingClaimRow | null> => {
        const rows = await this.generationQuery(relayDrizzle(this.#database, signal))
            .where(inArray(computerPairing.generation, currentGeneration()))
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readComputerPairingRequest = async (
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<ComputerPairingRow | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({
                pairing_code_hash: computerPairing.pairingCodeHash,
                poll_token_hash: computerPairing.pollTokenHash,
                expires_at: computerPairing.expiresAt,
            })
            .from(computerPairing)
            .where(eq(computerPairing.creationIdempotencyKey, idempotencyKey))
            .limit(1);
        return rows[0] ?? null;
    };

    /**
     * Starts the computer's next pairing generation, unless a generation is still open: claimed, or awaiting its claim
     * before its deadline, and in either case not revoked.
     */
    readonly createComputerPairing = async (value: CreateComputerPairing, signal: AbortSignal): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const openGenerations = database
            .select({ open: count().as("open") })
            .from(computerPairing)
            .leftJoin(computerRegistration, eq(computerRegistration.generation, computerPairing.generation))
            .where(
                and(
                    notInArray(
                        computerPairing.generation,
                        database.select({ generation: computerRevocation.generation }).from(computerRevocation),
                    ),
                    or(isNotNull(computerRegistration.generation), gt(computerPairing.expiresAt, value.now)),
                ),
            )
            .as("open_generations");
        const pairing = database.insert(computerPairing).select(
            database
                .select({
                    generation: bound<number | null>(null, "generation"),
                    pairingCodeHash: bound(value.codeHash, "pairing_code_hash"),
                    pollTokenHash: bound(value.pollHash, "poll_token_hash"),
                    expiresAt: bound(value.expiresAt, "expires_at"),
                    creationIdempotencyKey: bound(value.idempotencyKey, "creation_idempotency_key"),
                })
                .from(openGenerations)
                .where(eq(openGenerations.open, 0)),
        );
        return this.#database.run(pairing, signal).meta.changes === 1;
    };

    readonly claim = async (
        value: {
            readonly codeHash: string;
            readonly daemonHash: string;
            readonly now: number;
            readonly computerName: string;
            readonly workspaceName: string;
            readonly agents: readonly AgentDescriptor[];
        },
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const claimable = database
            .select({ generation: computerPairing.generation })
            .from(computerPairing)
            .where(
                and(
                    inArray(computerPairing.generation, currentGeneration()),
                    eq(computerPairing.pairingCodeHash, value.codeHash),
                    gt(computerPairing.expiresAt, value.now),
                    notInArray(
                        computerPairing.generation,
                        database.select({ generation: computerRegistration.generation }).from(computerRegistration),
                    ),
                    notInArray(
                        computerPairing.generation,
                        database.select({ generation: computerRevocation.generation }).from(computerRevocation),
                    ),
                ),
            );
        const credential = database.insert(daemonCredential).select(
            database
                .select({
                    generation: computerPairing.generation,
                    tokenHash: bound(value.daemonHash, "token_hash"),
                })
                .from(computerPairing)
                .where(inArray(computerPairing.generation, claimable)),
        );
        // Inserted before the registration, which ends the claim's eligibility.
        const catalog = database.insert(computerAgentCatalog).select(
            database
                .select({
                    generation: daemonCredential.generation,
                    agents: bound(JSON.stringify(value.agents), "agents"),
                })
                .from(daemonCredential)
                .where(
                    and(
                        eq(daemonCredential.tokenHash, value.daemonHash),
                        inArray(daemonCredential.generation, claimable),
                    ),
                ),
        );
        const registration = database.insert(computerRegistration).select(
            database
                .select({
                    generation: daemonCredential.generation,
                    computerName: bound(value.computerName, "computer_name"),
                    workspaceName: bound(value.workspaceName, "workspace_name"),
                })
                .from(daemonCredential)
                .where(
                    and(
                        eq(daemonCredential.tokenHash, value.daemonHash),
                        inArray(daemonCredential.generation, claimable),
                    ),
                ),
        );
        const results = this.#database.batch([credential, catalog, registration], signal);
        return results[0]?.meta.changes === 1;
    };

    readonly readComputer = async (signal: AbortSignal): Promise<ComputerPairingDirectoryRow | null> => {
        const row = await this.readCurrentPairing(signal);
        return row === null ? null : { revoked_at: row.revoked_at, registration: row.registration, agents: row.agents };
    };

    readonly isActiveDaemon = async (tokenHash: string, signal: AbortSignal): Promise<boolean> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ generation: daemonCredential.generation })
            .from(daemonCredential)
            .where(
                and(
                    eq(daemonCredential.tokenHash, tokenHash),
                    inArray(daemonCredential.generation, activeGeneration()),
                ),
            )
            .limit(1);
        return rows.length === 1;
    };

    /**
     * Presents a daemon credential with the successor the daemon saved before connecting. A current credential is
     * retired, remembering the successor that replaced it, and the successor becomes current. A retired credential
     * still identifies its Computer: presented with the successor that replaced it, while that successor is current, it
     * repeats a rotation whose reply was lost; presented any other way, a copy of it is in use elsewhere.
     */
    readonly rotateDaemonCredential = async (
        presentedHash: string,
        successorHash: string,
        signal: AbortSignal,
    ): Promise<ComputerCredentialRotation> => {
        const database = relayDrizzle(this.#database, signal);
        const active = activeGeneration();
        const current = and(
            eq(daemonCredential.tokenHash, presentedHash),
            inArray(daemonCredential.generation, active),
        );
        this.#database.batch(
            [
                database.insert(retiredDaemonCredential).select(
                    database
                        .select({
                            tokenHash: daemonCredential.tokenHash,
                            generation: daemonCredential.generation,
                            successorHash: bound(successorHash, "successor_hash"),
                        })
                        .from(daemonCredential)
                        .where(current),
                ),
                database.update(daemonCredential).set({ tokenHash: successorHash }).where(current),
            ],
            signal,
        );
        const rows = await database
            .select({
                successor_hash: retiredDaemonCredential.successorHash,
                current_hash: daemonCredential.tokenHash,
            })
            .from(retiredDaemonCredential)
            .innerJoin(daemonCredential, eq(daemonCredential.generation, retiredDaemonCredential.generation))
            .where(
                and(
                    eq(retiredDaemonCredential.tokenHash, presentedHash),
                    inArray(retiredDaemonCredential.generation, active),
                ),
            )
            .limit(1);
        const row = rows[0];
        if (row !== undefined) {
            return row.successor_hash === successorHash && row.current_hash === successorHash
                ? { kind: "rotated" }
                : { kind: "reused" };
        }
        // Every generation keeps its credentials, so a daemon of an ended generation learns its access ended for good,
        // also after the computer was paired again.
        const ended = await database
            .select({ generation: daemonCredential.generation })
            .from(daemonCredential)
            .where(eq(daemonCredential.tokenHash, presentedHash))
            .union(
                database
                    .select({ generation: retiredDaemonCredential.generation })
                    .from(retiredDaemonCredential)
                    .where(eq(retiredDaemonCredential.tokenHash, presentedHash)),
            )
            .limit(1);
        return ended.length === 0 ? { kind: "unknown" } : { kind: "revoked" };
    };

    readonly revokeComputer = async (now: number, signal: AbortSignal): Promise<ComputerPairingDirectoryRow | null> => {
        const database = relayDrizzle(this.#database, signal);
        const current = currentGeneration();
        const revocation = database
            .insert(computerRevocation)
            .select(
                database
                    .select({ generation: computerPairing.generation, revokedAt: bound(now, "revoked_at") })
                    .from(computerPairing)
                    .where(inArray(computerPairing.generation, current)),
            )
            .onConflictDoNothing();
        this.#database.run(revocation, signal);
        // Reading the committed fact makes overlapping retries return the first revocation time.
        return await this.readComputer(signal);
    };

    readonly listComputers = async (signal: AbortSignal) => {
        const row = await this.readComputer(signal);
        return row?.registration && row.revoked_at === null ? [{ ...row.registration, agents: row.agents ?? [] }] : [];
    };

    /** Replaces the catalog of the generation this daemon credential is active for; false for any other credential. */
    readonly replaceAgents = async (
        tokenHash: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const replaced = database
            .insert(computerAgentCatalog)
            .select(
                database
                    .select({
                        generation: daemonCredential.generation,
                        agents: bound(JSON.stringify(agents), "agents"),
                    })
                    .from(daemonCredential)
                    .where(
                        and(
                            eq(daemonCredential.tokenHash, tokenHash),
                            inArray(daemonCredential.generation, activeGeneration()),
                        ),
                    ),
            )
            .onConflictDoUpdate({ target: computerAgentCatalog.generation, set: { agents } });
        return this.#database.run(replaced, signal).meta.changes === 1;
    };
}
