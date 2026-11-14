import type { VerifiedComputerAccess } from "../../../../contracts/relay/pairing.ts";
import { PairingDirectoryError, validateIdentifier } from "../../../../contracts/relay/pairing.ts";
import type { ComputerIdentityCredential } from "../../../../contracts/relay/pairing-identity.ts";
import { DatabaseError } from "../../../../infra/sql-database.ts";
import type { ComputerRelayStore } from "../storage/computer-relay-store.ts";
import type { ComputerAccessService } from "./computer-access-service.ts";

/** A credential that matches nothing, including one stored for a Computer that is no longer served. */
function unmatchedCredential(credential: ComputerIdentityCredential): PairingDirectoryError {
    const code = credential.kind === "pairing-code" ? "invalid_pairing_code" : "unauthorized";
    return new PairingDirectoryError(code, "A valid pairing or channel credential is required");
}

/**
 * Verifies credentials against the owning computer's store, then checks its authoritative directory lifecycle.
 */
export class ComputerIdentityService {
    readonly #computerId: string;
    readonly #store: ComputerRelayStore;
    readonly #accounts: Pick<ComputerAccessService, "isActive">;
    constructor(computerId: string, store: ComputerRelayStore, accounts: Pick<ComputerAccessService, "isActive">) {
        this.#computerId = computerId;
        this.#store = store;
        this.#accounts = accounts;
    }

    readonly authenticate = async (credential: ComputerIdentityCredential, signal: AbortSignal): Promise<void> => {
        await this.#requireHeld(credential, signal);
        const active = await this.#accounts.isActive(this.#computerId, signal);
        signal.throwIfAborted();
        if (!active) {
            throw unmatchedCredential(credential);
        }
    };

    /**
     * Presents a daemon credential with its successor. The Computer store rotates the credential; a retired credential
     * presented with another successor is reported as reused, for the caller to end the Computer's access, and one of a
     * Computer whose access already ended as revoked.
     */
    readonly rotateComputer = async (
        presentedHash: string,
        successorHash: string,
        signal: AbortSignal,
    ): Promise<
        { readonly kind: "rotated" | "reused"; readonly access: VerifiedComputerAccess } | { readonly kind: "revoked" }
    > => {
        signal.throwIfAborted();
        try {
            const rotation = await this.#store.rotateComputerCredential(presentedHash, successorHash, signal);
            switch (rotation.kind) {
                case "revoked":
                    return rotation;
                case "unknown":
                    throw new PairingDirectoryError("unauthorized", "A valid Computer credential is required");
                case "rotated":
                case "reused":
                    break;
                default:
                    return rotation satisfies never;
            }
            const computerId = this.#computerId;
            const active = await this.#accounts.isActive(computerId, signal);
            signal.throwIfAborted();
            if (!active) {
                throw new PairingDirectoryError("unauthorized", "A valid Computer credential is required");
            }
            return {
                kind: rotation.kind,
                access: { computerId },
            };
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof PairingDirectoryError) {
                throw cause;
            }
            if (cause instanceof DatabaseError && cause.code === "database_timeout") {
                throw new PairingDirectoryError("directory_timeout", "The Computer directory timed out", { cause });
            }
            throw new PairingDirectoryError("directory_unavailable", "The Computer directory is unavailable", {
                cause,
            });
        }
    };

    readonly #requireHeld = async (credential: ComputerIdentityCredential, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        try {
            // A daemon credential names its Computer; it must be this one.
            if (
                credential.kind === "daemon" &&
                validateIdentifier(credential.computerId, "computer_id") !== this.#computerId
            ) {
                throw unmatchedCredential(credential);
            }
            const held = await this.#store.holdsCredential(credential, signal);
            signal.throwIfAborted();
            if (!held) {
                throw unmatchedCredential(credential);
            }
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof PairingDirectoryError) {
                throw cause;
            }
            if (cause instanceof DatabaseError && cause.code === "database_timeout") {
                throw new PairingDirectoryError("directory_timeout", "The Computer directory timed out", { cause });
            }
            throw new PairingDirectoryError("directory_unavailable", "The Computer directory is unavailable", {
                cause,
            });
        }
    };
}
