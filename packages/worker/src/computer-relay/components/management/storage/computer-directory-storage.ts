import { and, count, eq, gt, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import type {
    ComputerCredentialRotation,
    ComputerPairingDirectoryRow,
    ComputerPairingRow,
    PairingClaimRow,
} from "../../../../contracts/relay/pairing-records.ts";
import { type RelayDrizzleDatabase, relayDrizzle } from "../../../../infra/drizzle-database.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import {
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
    agents_json: computerRegistration.agentsJson,
};
interface CreateComputerPairing {
    readonly codeHash: string;
    readonly pollHash: string;
    readonly now: number;
    readonly expiresAt: number;
    readonly idempotencyKey: string;
}

/** A bound value selected as a column, for rows an INSERT ... SELECT writes. */
const bound = <T>(value: T, name: string) => sql<T>`${value}`.as(name);

/**
 * The computer's pairing generations. Each transition records a fact of one generation; pairing the computer again
 * starts a new generation instead of changing an earlier one.
 */
export class ComputerDirectoryStorage {
    readonly #computerId: string;
    readonly #database: DurableObjectDatabase;

    constructor(computerId: string, database: DurableObjectDatabase) {
        this.#computerId = computerId;
        this.#database = database;
    }

    /** A generation's request, with its registration and revocation when they happened. */
    private readonly generationQuery = (database: RelayDrizzleDatabase) =>
        database
            .select({
                computer_id: computerPairing.computerId,
                poll_token_hash: computerPairing.pollTokenHash,
                expires_at: computerPairing.expiresAt,
                revoked_at: computerRevocation.revokedAt,
                registration: registrationFields,
            })
            .from(computerPairing)
            .leftJoin(computerRegistration, eq(computerRegistration.generation, computerPairing.generation))
            .leftJoin(computerRevocation, eq(computerRevocation.generation, computerPairing.generation));

    readonly readPairingCode = async (codeHash: string, signal: AbortSignal): Promise<PairingClaimRow | null> => {
        const rows = await this.generationQuery(relayDrizzle(this.#database, signal))
            .where(and(eq(computerPairing.computerId, this.#computerId), eq(computerPairing.pairingCodeHash, codeHash)))
            .limit(1);
        return rows[0] ?? null;
    };

    /** The computer's current generation; null before it was ever paired. */
    readonly readCurrentPairing = async (signal: AbortSignal): Promise<PairingClaimRow | null> => {
        const rows = await this.generationQuery(relayDrizzle(this.#database, signal))
            .where(inArray(computerPairing.generation, currentGeneration(this.#computerId)))
            .limit(1);
        return rows[0] ?? null;
    };

    readonly readComputerPairingRequest = async (
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<ComputerPairingRow | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({
                computer_id: computerPairing.computerId,
                pairing_code_hash: computerPairing.pairingCodeHash,
                poll_token_hash: computerPairing.pollTokenHash,
                expires_at: computerPairing.expiresAt,
            })
            .from(computerPairing)
            .where(
                and(
                    eq(computerPairing.computerId, this.#computerId),
                    eq(computerPairing.creationIdempotencyKey, idempotencyKey),
                ),
            )
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
                    eq(computerPairing.computerId, this.#computerId),
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
                    // SQLite assigns the next generation in place of a null one.
                    generation: bound<number | null>(null, "generation"),
                    computerId: bound(this.#computerId, "computer_id"),
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

    /** Registers the daemon that presented the current generation's unexpired pairing code. */
    readonly claim = async (
        value: {
            readonly codeHash: string;
            readonly daemonHash: string;
            readonly now: number;
            readonly computerName: string;
            readonly workspaceName: string;
            readonly agents: string;
        },
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const claimable = database
            .select({ generation: computerPairing.generation })
            .from(computerPairing)
            .where(
                and(
                    eq(computerPairing.computerId, this.#computerId),
                    inArray(computerPairing.generation, currentGeneration(this.#computerId)),
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
        // The credential written just above marks the generation this claim registers.
        const registration = database.insert(computerRegistration).select(
            database
                .select({
                    generation: daemonCredential.generation,
                    computerName: bound(value.computerName, "computer_name"),
                    workspaceName: bound(value.workspaceName, "workspace_name"),
                    agentsJson: bound(value.agents, "agents_json"),
                })
                .from(daemonCredential)
                .where(
                    and(
                        eq(daemonCredential.tokenHash, value.daemonHash),
                        inArray(daemonCredential.generation, claimable),
                    ),
                ),
        );
        const results = this.#database.batch([credential, registration], signal);
        return results[0]?.meta.changes === 1;
    };

    /** The computer's current generation as a Computer: its registration and revocation, if they happened. */
    readonly readComputer = async (signal: AbortSignal): Promise<ComputerPairingDirectoryRow | null> => {
        const row = await this.readCurrentPairing(signal);
        return row === null
            ? null
            : { computer_id: row.computer_id, revoked_at: row.revoked_at, registration: row.registration };
    };

    readonly readDaemon = async (tokenHash: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ computer_id: computerPairing.computerId })
            .from(daemonCredential)
            .innerJoin(computerPairing, eq(computerPairing.generation, daemonCredential.generation))
            .where(
                and(
                    eq(computerPairing.computerId, this.#computerId),
                    eq(daemonCredential.tokenHash, tokenHash),
                    inArray(daemonCredential.generation, activeGeneration(this.#computerId)),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
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
        const active = activeGeneration(this.#computerId);
        const current = and(
            eq(daemonCredential.tokenHash, presentedHash),
            inArray(daemonCredential.generation, active),
        );
        // One batch: the presented credential is retired with its successor exactly when the successor replaces it.
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
        const computer = { computer_id: this.#computerId };
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
                ? { kind: "rotated", computer }
                : { kind: "reused", computer };
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

    /** Ends the current generation's access, once; a repeated revocation returns the first one. */
    readonly revokeComputer = async (now: number, signal: AbortSignal): Promise<ComputerPairingDirectoryRow | null> => {
        const database = relayDrizzle(this.#database, signal);
        const current = currentGeneration(this.#computerId);
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
        return row?.registration && row.revoked_at === null
            ? [{ computer_id: row.computer_id, ...row.registration }]
            : [];
    };

    readonly updateAgents = async (tokenHash: string, agents: string, signal: AbortSignal) => {
        const database = relayDrizzle(this.#database, signal);
        return this.#database.run(
            database
                .update(computerRegistration)
                .set({ agentsJson: agents })
                .where(
                    inArray(
                        computerRegistration.generation,
                        database
                            .select({ generation: daemonCredential.generation })
                            .from(daemonCredential)
                            .where(
                                and(
                                    eq(daemonCredential.tokenHash, tokenHash),
                                    inArray(daemonCredential.generation, activeGeneration(this.#computerId)),
                                ),
                            ),
                    ),
                ),
            signal,
        );
    };
}
