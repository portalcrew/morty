import { isComputerCredentialSuccessor } from "@morty-build/client/protocol";
import type { ComputerAccess } from "../../../../contracts/relay/computer-authentication.ts";
import { computerPairingStatus, computerRevokedAt } from "../../../../contracts/relay/computer-pairing-state.ts";
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
    parseAgents,
    validateIdentifier,
    validateToken,
} from "../../../../contracts/relay/pairing.ts";
import type { ComputerIdentityCredential } from "../../../../contracts/relay/pairing-identity.ts";
import type { ComputerPairingRow } from "../../../../contracts/relay/pairing-records.ts";
import type { ComputerRelayStore } from "../storage/computer-relay-store.ts";
import type { ComputerAccessService } from "./computer-access-service.ts";
import { deriveComputerDaemonToken, deriveComputerPairingSecrets } from "./computer-pairing-secrets.ts";
import type { ComputerIdentityService } from "./pairing-identity-service.ts";

export interface PairingDirectoryInfrastructure {
    readonly computerId: string;
    readonly store: ComputerRelayStore;
    readonly services: {
        readonly identities: ComputerIdentityService;
        readonly computerAccounts: Pick<ComputerAccessService, "authorizeComputer" | "isActive">;
    };
}

export class PairingDirectoryService {
    readonly #cx: PairingDirectoryInfrastructure;

    constructor(cx: PairingDirectoryInfrastructure) {
        this.#cx = cx;
    }

    private readonly activeStorage = async (computerId: string, signal: AbortSignal) => {
        const active = await this.#cx.services.computerAccounts.isActive(computerId, signal);
        signal.throwIfAborted();
        if (!active) {
            throw new PairingDirectoryError("unauthorized", "The Computer is no longer active");
        }
        return this.#cx.store;
    };

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
        const storage = await this.activeStorage(rotation.access.computerId, signal);
        await storage.revokeComputer(Date.now(), signal);
        return rotation;
    };

    readonly authorizeComputer = async (computerId: string, signal: AbortSignal): Promise<ComputerAccess> =>
        await this.#cx.services.computerAccounts.authorizeComputer(computerId, signal);

    readonly authorizeMetadataSnapshot = async (
        token: string,
        successor: string | null,
        signal: AbortSignal,
    ): Promise<void> => {
        for (const presented of successor === null ? [token] : [token, successor]) {
            try {
                await this.identityStorage(
                    {
                        kind: "daemon",
                        computerId: this.#cx.computerId,
                        tokenHash: await hashPairingCredential(validateToken(presented)),
                    },
                    signal,
                );
                return;
            } catch (cause) {
                signal.throwIfAborted();
                if (!(cause instanceof PairingDirectoryError && cause.code === "unauthorized")) {
                    throw cause;
                }
            }
        }
        throw new PairingDirectoryError("unauthorized", "An active Computer credential is required");
    };

    private readonly decodeCreatedComputerPairing = async (
        row: ComputerPairingRow,
        owner: ComputerAccess,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ) => {
        const secrets = await deriveComputerPairingSecrets(pairingKey, owner.computerId, idempotencyKey);
        const codeHash = await hashPairingCredential(secrets.pairingCode);
        const pollHash = await hashPairingCredential(secrets.pollToken);
        signal.throwIfAborted();
        if (row.pairing_code_hash !== codeHash || row.poll_token_hash !== pollHash) {
            throw new PairingDirectoryError(
                "invalid_directory_record",
                "This pairing cannot be reused; reinstall Morty and create a new pairing",
            );
        }
        return new CreatedComputerPairing(
            new Date(row.expires_at).toISOString(),
            secrets.pairingCode,
            owner.computerId,
        );
    };

    /** Replays retain the original identity, secrets and deadline; retries keep the same key after an ambiguous failure. */
    readonly createComputerPairing = async (
        computerId: string,
        pairingKey: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<CreatedComputerPairing> => {
        const normalizedComputerId = validateIdentifier(computerId, "computer_id");
        const normalizedKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const owner = await this.authorizeComputer(normalizedComputerId, signal);
        const storage = await this.activeStorage(owner.computerId, signal);
        // The secrets derive from the request, so a retry presents the same hashes as the request it repeats.
        const secrets = await deriveComputerPairingSecrets(pairingKey, owner.computerId, normalizedKey);
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
                return this.decodeCreatedComputerPairing(stored.request, owner, pairingKey, normalizedKey, signal);
            case "quota_exceeded":
                throw new PairingDirectoryError(
                    "computer_quota_exceeded",
                    "This computer already has a daemon or pending pairing",
                );
            case "created":
                return new CreatedComputerPairing(
                    new Date(expiresAt).toISOString(),
                    secrets.pairingCode,
                    owner.computerId,
                );
        }
    };

    readonly readComputerPairing = async (computerId: string, signal: AbortSignal): Promise<PairingStatus> => {
        const owner = await this.authorizeComputer(computerId, signal);
        const storage = await this.activeStorage(owner.computerId, signal);
        const row = await storage.readComputerPairing(signal);
        if (row === null) {
            throw new PairingDirectoryError("pairing_not_found", "The Computer pairing request was not found");
        }
        return computerPairingStatus(row, owner.computerId, Date.now());
    };

    private readonly redeemPairing = async (
        expectedComputerId: string,
        pairingCode: string,
        computerName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<ClaimedPairing> => {
        signal.throwIfAborted();
        const codeHash = await hashPairingCredential(normalizePairingCode(pairingCode));
        const storage = await this.identityStorage({ kind: "pairing-code", codeHash }, signal);
        const pairing = await storage.readPairingCode(codeHash, signal);
        const computerId = this.#cx.computerId;
        if (pairing === null || computerId !== expectedComputerId) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        await this.#cx.services.computerAccounts.authorizeComputer(computerId, signal);
        const daemonToken = await deriveComputerDaemonToken(pairingCode, computerId, pairing.poll_token_hash);
        const claimed = await storage.claimPairing(
            {
                codeHash,
                daemonHash: await hashPairingCredential(daemonToken),
                now: Date.now(),
                computerName,
                workspaceName,
                agents: JSON.stringify(agents),
            },
            signal,
        );
        if (!claimed) {
            throw new PairingDirectoryError("invalid_pairing_code", "The pairing code is invalid or expired");
        }
        return { computerId, daemonToken };
    };

    readonly redeemComputerPairing = async (
        computerId: string,
        pairingCode: string,
        computerName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        signal: AbortSignal,
    ): Promise<ClaimedPairing> =>
        await this.redeemPairing(
            validateIdentifier(computerId, "computer_id"),
            pairingCode,
            computerName,
            workspaceName,
            agents,
            signal,
        );

    readonly listComputers = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<readonly ComputerDescriptor[]> => {
        const access = await this.authorizeComputer(computerId, signal);
        const storage = await this.activeStorage(access.computerId, signal);
        const runtimes = await storage.listComputers(signal);
        return runtimes.map(
            (row) =>
                new ComputerDescriptor(
                    parseAgents(row.agents_json),
                    row.computer_name,
                    row.workspace_name,
                    access.computerId,
                ),
        );
    };

    readonly isComputerRevoked = async (computerId: string, signal: AbortSignal): Promise<boolean> => {
        const access = await this.authorizeComputer(computerId, signal);
        const storage = await this.activeStorage(access.computerId, signal);
        const row = await storage.readComputer(signal);
        return row !== null && computerRevokedAt(row.revoked_at) !== null;
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
            if (await storage.updateAgentCatalog(tokenHash, JSON.stringify(agents), signal)) {
                return;
            }
        }
        throw new PairingDirectoryError("unauthorized", "A valid channel token is required");
    };
}
