import { isComputerCredentialSuccessor } from "@portalcrew/morty-client/protocol";
import { computerPairingStatus } from "../../../../contracts/relay/computer-pairing-state.ts";
import type {
    AgentDescriptor,
    ClaimedPairing,
    PairingStatus,
    VerifiedComputerAccess,
} from "../../../../contracts/relay/pairing.ts";
import {
    ComputerDescriptor,
    CreatedComputerPairing,
    hashPairingCredential,
    normalizePairingCode,
    PAIRING_LIFETIME_MILLISECONDS,
    PairingDirectoryError,
    validateIdentifier,
    validateToken,
} from "../../../../contracts/relay/pairing.ts";
import type { ComputerIdentityCredential } from "../../../../contracts/relay/pairing-identity.ts";
import type { ComputerRelayStore } from "../storage/computer-relay-store.ts";
import type { ComputerAccessService } from "./computer-access-service.ts";
import { deriveComputerDaemonToken, deriveComputerPairingSecrets } from "./computer-pairing-secrets.ts";
import type { IdentityOperations } from "./identity-operations.ts";
import type { ComputerIdentityService } from "./pairing-identity-service.ts";

export interface PairingDirectoryInfrastructure {
    readonly computerId: string;
    readonly store: ComputerRelayStore;
    /** The key pairing secrets derive from, so a retry derives the secrets its request stored. */
    readonly credentialKey: IdentityOperations["credentialKey"];
    readonly services: {
        readonly identities: ComputerIdentityService;
        readonly computerAccounts: Pick<ComputerAccessService, "authorizeComputer">;
    };
}

export class PairingDirectoryService {
    readonly #cx: PairingDirectoryInfrastructure;

    constructor(cx: PairingDirectoryInfrastructure) {
        this.#cx = cx;
    }

    private readonly identityStorage = async (credential: ComputerIdentityCredential, signal: AbortSignal) => {
        await this.#cx.services.identities.authenticate(credential, signal);
        return this.#cx.store;
    };

    readonly rotateComputerCredential = async (
        token: string,
        successor: string,
        signal: AbortSignal,
    ): Promise<{
        readonly kind: "rotated" | "reused" | "revoked";
        readonly access: VerifiedComputerAccess;
    }> => {
        signal.throwIfAborted();
        const current = validateToken(token);
        if (!isComputerCredentialSuccessor(current, successor)) {
            throw new PairingDirectoryError("unauthorized", "A valid Computer credential successor is required");
        }
        const rotation = await this.#cx.services.identities.rotateComputer(
            await hashPairingCredential(current),
            await hashPairingCredential(successor),
            signal,
        );
        if (rotation.kind === "revoked") {
            return { kind: "revoked", access: { computerId: this.#cx.computerId } };
        }
        if (rotation.kind !== "reused") {
            return rotation;
        }
        // Only the daemon that saved a successor can present the retired credential with it. Another successor means
        // a copy of the credential connected first, so neither copy may keep the Computer.
        await this.#cx.store.revokeComputer(Date.now(), signal);
        return rotation;
    };

    readonly #authorizeComputer = (computerId: string): void =>
        this.#cx.services.computerAccounts.authorizeComputer(computerId);

    /**
     * Replays retain the original identity, secrets and deadline; retries keep the same key after an ambiguous failure.
     * The secrets derive from the computer's durable key and the request, never from deployment configuration, so a
     * retry derives the secrets its request stored even after the deployment's credentials rotated.
     */
    readonly createComputerPairing = async (
        computerId: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<CreatedComputerPairing> => {
        const normalizedComputerId = validateIdentifier(computerId, "computer_id");
        const normalizedKey = validateIdentifier(idempotencyKey, "idempotency_key");
        this.#authorizeComputer(normalizedComputerId);
        const storage = this.#cx.store;
        const secrets = await deriveComputerPairingSecrets(
            await this.#cx.credentialKey(signal),
            normalizedComputerId,
            normalizedKey,
        );
        const now = Date.now();
        const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;
        let stored: Awaited<ReturnType<ComputerRelayStore["requestComputerPairing"]>>;
        try {
            stored = await storage.requestComputerPairing(
                {
                    codeHash: await hashPairingCredential(secrets.pairingCode),
                    pollHash: await hashPairingCredential(secrets.pollToken),
                    now,
                    expiresAt,
                    idempotencyKey: normalizedKey,
                },
                signal,
            );
        } catch (cause) {
            signal.throwIfAborted();
            throw new PairingDirectoryError("directory_unavailable", "The Computer pairing could not be stored", {
                cause,
            });
        }
        switch (stored.kind) {
            case "existing":
                return new CreatedComputerPairing(
                    new Date(stored.request.expires_at).toISOString(),
                    secrets.pairingCode,
                    normalizedComputerId,
                );
            case "quota_exceeded":
                throw new PairingDirectoryError(
                    "computer_quota_exceeded",
                    "This computer already has a daemon or pending pairing",
                );
            case "created":
                return new CreatedComputerPairing(
                    new Date(expiresAt).toISOString(),
                    secrets.pairingCode,
                    normalizedComputerId,
                );
        }
    };

    readonly readComputerPairing = async (computerId: string, signal: AbortSignal): Promise<PairingStatus> => {
        this.#authorizeComputer(computerId);
        const row = await this.#cx.store.readComputerPairing(signal);
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The Computer pairing request was not found");
        }
        return computerPairingStatus(row, computerId, Date.now());
    };

    readonly redeemComputerPairing = async (
        computerId: string,
        pairingCode: string,
        computerName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<ClaimedPairing> => {
        const expectedComputerId = validateIdentifier(computerId, "computer_id");
        signal.throwIfAborted();
        const codeHash = await hashPairingCredential(normalizePairingCode(pairingCode));
        const storage = await this.identityStorage({ kind: "pairing-code", codeHash }, signal);
        const pairing = await storage.readPairingCode(codeHash, signal);
        const boundComputerId = this.#cx.computerId;
        if (pairing === null || boundComputerId !== expectedComputerId) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        const daemonToken = await deriveComputerDaemonToken(pairingCode, boundComputerId, pairing.poll_token_hash);
        const claimed = await storage.claimPairing(
            {
                codeHash,
                daemonHash: await hashPairingCredential(daemonToken),
                now: Date.now(),
                computerName,
                workspaceName,
                agents,
            },
            signal,
        );
        if (!claimed) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        return { computerId: boundComputerId, daemonToken };
    };

    readonly listComputers = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<readonly ComputerDescriptor[]> => {
        this.#authorizeComputer(computerId);
        const row = await this.#cx.store.readComputerPairing(signal);
        const status = row === null ? null : computerPairingStatus(row, computerId, Date.now());
        return status?.status === "paired"
            ? [new ComputerDescriptor(status.agents, status.computerName, status.workspaceName, computerId)]
            : [];
    };

    readonly isComputerRevoked = async (computerId: string, signal: AbortSignal): Promise<boolean> => {
        this.#authorizeComputer(computerId);
        const row = await this.#cx.store.readComputerPairing(signal);
        return row !== null && computerPairingStatus(row, computerId, Date.now()).status === "revoked";
    };

    readonly updateAgentCatalog = async (
        computerId: string,
        token: string,
        successor: string | null,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        // Whichever presented credential the Relay holds as current authorizes; holding it is the proof.
        for (const presented of successor === null ? [token] : [token, successor]) {
            const tokenHash = await hashPairingCredential(validateToken(presented));
            let storage: ComputerRelayStore;
            try {
                storage = await this.identityStorage({ kind: "daemon", computerId, tokenHash }, signal);
            } catch (cause) {
                if (cause instanceof PairingDirectoryError && cause.code === "unauthorized") {
                    continue;
                }
                throw cause;
            }
            if (await storage.replaceAgentCatalog(tokenHash, agents, signal)) {
                return;
            }
        }
        throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
    };
}
