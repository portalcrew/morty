import type { ComputerIdentityCredential } from "../../../../contracts/relay/pairing-identity.ts";
import type {
    ComputerCredentialRotation,
    ComputerDirectoryRow,
    ComputerPairingDirectoryRow,
    ComputerPairingRow,
    PairingClaimRow,
    PairingComputerRow,
} from "../../../../contracts/relay/pairing-records.ts";
import type { DurableObjectDatabase } from "../../../infra/durable-object-database.ts";
import { ComputerCredentialStorage } from "./computer-credential-storage.ts";
import { ComputerDirectoryStorage } from "./computer-directory-storage.ts";
import { credentialMatches } from "./pairing-identity-storage.ts";

interface RequestComputerPairing {
    readonly codeHash: string;
    readonly pollHash: string;
    readonly now: number;
    readonly expiresAt: number;
    readonly idempotencyKey: string;
}

/** The pairing request stored under the idempotency key, or the quota that refused a new one. */
type ComputerPairingRequest =
    | { readonly kind: "created" }
    | { readonly kind: "existing"; readonly request: ComputerPairingRow }
    | { readonly kind: "quota_exceeded" };

interface ClaimPairing {
    readonly codeHash: string;
    readonly daemonHash: string;
    readonly now: number;
    readonly computerName: string;
    readonly workspaceName: string;
    readonly agents: string;
}

/**
 * The operations on the computer's own SQLite storage. Only its ComputerRelay constructs this; each operation runs
 * there as one unit, so the preconditions it checks and the writes it makes are evaluated together. A null or false
 * result means the precondition did not hold and nothing was written.
 */
export class ComputerRelayStore {
    readonly #database: DurableObjectDatabase;
    readonly #computers: ComputerDirectoryStorage;
    readonly #credentials: ComputerCredentialStorage;

    constructor(database: DurableObjectDatabase) {
        this.#database = database;
        this.#computers = new ComputerDirectoryStorage(database);
        this.#credentials = new ComputerCredentialStorage(database);
    }

    readonly updateAgentCatalog = async (tokenHash: string, agents: string, signal: AbortSignal): Promise<boolean> =>
        (await this.#computers.updateAgents(tokenHash, agents, signal)).meta.changes === 1;

    /** The pairing generation whose daemon may act for the computer now; null while none may. */
    readonly readActiveGeneration = async (signal: AbortSignal): Promise<number | null> =>
        await this.#credentials.readActiveGeneration(signal);

    readonly readComputer = async (signal: AbortSignal): Promise<ComputerPairingDirectoryRow | null> =>
        await this.#computers.readComputer(signal);

    readonly listComputers = async (signal: AbortSignal): Promise<readonly ComputerDirectoryRow[]> =>
        await this.#computers.listComputers(signal);

    /** Returns the pairing request created under the idempotency key, or creates one within the Computer quota. */
    readonly requestComputerPairing = async (
        value: RequestComputerPairing,
        signal: AbortSignal,
    ): Promise<ComputerPairingRequest> => {
        const existing = await this.#computers.readComputerPairingRequest(value.idempotencyKey, signal);
        if (existing !== null) {
            return { kind: "existing", request: existing };
        }
        if (await this.#computers.createComputerPairing(value, signal)) {
            return { kind: "created" };
        }
        return { kind: "quota_exceeded" };
    };

    readonly readComputerPairing = async (signal: AbortSignal): Promise<PairingComputerRow | null> =>
        await this.#computers.readCurrentPairing(signal);

    readonly readPairingCode = async (codeHash: string, signal: AbortSignal): Promise<PairingClaimRow | null> =>
        await this.#computers.readPairingCode(codeHash, signal);

    /**
     * Claims a pairing for a daemon. A replay with the credential it committed succeeds while the pairing is
     * unexpired; any other failed claim returns false.
     */
    readonly claimPairing = async (value: ClaimPairing, signal: AbortSignal): Promise<boolean> => {
        if (await this.#computers.claim(value, signal)) {
            return true;
        }
        // Replays prove possession of the original code and must match the committed credential. Never rotate an
        // retired credential, extend the pairing deadline, or resurrect a revoked Computer.
        const pairing = await this.#computers.readCurrentPairing(signal);
        return (
            pairing !== null &&
            pairing.expires_at > value.now &&
            (await this.#computers.isActiveDaemon(value.daemonHash, signal))
        );
    };

    /**
     * Revokes the Computer and returns its committed revocation; null when it was never paired. Ending its pairing
     * generation also ends the Session credentials issued under it.
     */
    readonly revokeComputer = async (now: number, signal: AbortSignal): Promise<ComputerPairingDirectoryRow | null> =>
        await this.#computers.revokeComputer(now, signal);

    /** Whether the computer holds the credential; the caller decides what a match authorizes. */
    readonly holdsCredential = async (credential: ComputerIdentityCredential, signal: AbortSignal): Promise<boolean> =>
        await credentialMatches(this.#database, credential, signal);

    readonly rotateComputerCredential = async (
        presentedHash: string,
        successorHash: string,
        signal: AbortSignal,
    ): Promise<ComputerCredentialRotation> =>
        await this.#computers.rotateDaemonCredential(presentedHash, successorHash, signal);
}
