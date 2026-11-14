import type { AccountProvisioner } from "../../../../contracts/account-provisioning.ts";
import type { BootstrapOrigin } from "../../../../contracts/computer-bootstrap.ts";
import { decodeComputerPlacement } from "../../../../contracts/computer-id.ts";
import { type ComputerManagement, ComputerManagementError } from "../../../../contracts/computer-management.ts";
import { ManagementError } from "../../../../contracts/management-error.ts";
import type { ComputerIdentity } from "../entity/computer-identity.ts";
import type { JoiningDevice } from "../storage/identity-storage.ts";
import { randomSecret } from "../storage/identity-storage-common.ts";
import type { AuthenticationService } from "./authentication-service.ts";
import type { IdentityOperations } from "./identity-operations.ts";
import type { LocalComputerService } from "./local-computer-service.ts";

export class ManagementService {
    readonly #authentication: AuthenticationService;
    readonly #computerId: string;
    readonly #relay: LocalComputerService;
    readonly #credentialKey: IdentityOperations["credentialKey"];
    readonly #provisionAccount: AccountProvisioner;

    constructor(cx: {
        readonly identity: ComputerIdentity;
        readonly identityOperations: IdentityOperations;
        readonly services: {
            readonly authentication: AuthenticationService;
            readonly computers: LocalComputerService;
            readonly provisionAccount: AccountProvisioner;
        };
    }) {
        this.#authentication = cx.services.authentication;
        this.#computerId = cx.identity.computerId;
        this.#relay = cx.services.computers;
        this.#credentialKey = cx.identityOperations.credentialKey;
        this.#provisionAccount = cx.services.provisionAccount;
    }

    /**
     * Every step reuses what an earlier attempt committed, and the credential derives from the bootstrap's origin, so
     * repeating the same bootstrap completes it and returns the same identity instead of creating another.
     */
    readonly initializeComputer = async (
        computer: ComputerManagement,
        signal: AbortSignal,
        origin: BootstrapOrigin,
    ) => {
        const token = await bootstrapToken(this.#credentialKey, computer.computerId, origin, signal);
        return await this.#authentication.createComputer(computer.computerId, signal, token);
    };

    /** The owner's Computer: where its Runtime pairing stands, read from the Relay that owns it. */
    readonly readComputer = async (computerId: string, signal: AbortSignal) => {
        const computer = await this.findComputer(computerId, signal);
        if (computer === null) {
            throw new ManagementError("BOT_NOT_FOUND", "Computer is unavailable.", 404);
        }
        return { computerPairing: await this.#relay.readComputerPairing(computer.computerId, signal) };
    };

    readonly findComputer = async (computerId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return this.#computerId !== computerId ? null : { computerId: this.#computerId };
    };

    /** The previous Computer names its successor so replacement retries reuse it. */
    readonly replaceComputer = async (computerId: string, signal: AbortSignal) => {
        const previous = await this.findComputer(computerId, signal);
        if (previous === null) {
            throw new ComputerManagementError("COMPUTER_REQUIRED", "Finish Morty setup before replacing.", 409);
        }
        // The predecessor fixes the successor's creation identity, so retries reach the same computer.
        const reference = `replacement_${previous.computerId}`;
        const placement = decodeComputerPlacement(previous.computerId);
        if (placement === null) {
            throw new ComputerManagementError("INVALID_ACCOUNT_ID", "The Computer ID is invalid.", 400);
        }
        return await this.#provisionAccount(reference, placement.locationHint, signal);
    };

    readonly createComputerPairing = async (computerId: string, idempotencyKey: string, signal: AbortSignal) => {
        const computer = await this.#requireComputer(computerId, signal);
        return await this.#relay.createPairing(computer.computerId, idempotencyKey, signal);
    };

    readonly readComputerPairing = async (computerId: string, signal: AbortSignal) => {
        const computer = await this.#requireComputer(computerId, signal);
        return await this.#relay.readPairing(computer.computerId, signal);
    };

    /**
     * The credential derives from the link and the browser's redemption key, so repeating a redemption whose reply was
     * lost returns the same identity. A request without a key gets a credential no retry can name.
     */
    readonly redeemTransfer = async (
        code: string,
        replaces: string | null,
        joining: JoiningDevice,
        redemptionKey: string | null,
        signal: AbortSignal,
    ) => {
        // The version and input encoding are part of the persisted retry contract; keep them stable.
        const token = await derivedToken(
            this.#credentialKey,
            ["morty-transfer-redemption-v1", code, redemptionKey ?? randomSecret()],
            signal,
        );
        return await this.#authentication.redeemTransfer(code, replaces, joining, token, signal);
    };

    readonly #requireComputer = async (computerId: string, signal: AbortSignal) => {
        const computer = await this.findComputer(computerId, signal);
        if (computer === null) {
            throw new ComputerManagementError(
                "COMPUTER_REQUIRED",
                "Finish Morty setup before pairing a Computer.",
                409,
            );
        }
        return computer;
    };
}

/** The credential a bootstrap issues, derived so that repeating the same bootstrap issues it again. */
async function bootstrapToken(
    serverKey: IdentityOperations["credentialKey"],
    computerId: string,
    origin: BootstrapOrigin,
    signal: AbortSignal,
) {
    // The versions and input encodings are part of the persisted retry contract; keep them stable.
    switch (origin.kind) {
        case "created":
            return await derivedToken(
                serverKey,
                ["morty-computer-bootstrap-v1", computerId, origin.creationKey],
                signal,
            );
        case "replacement":
            return await derivedToken(
                serverKey,
                ["morty-computer-replacement-v1", origin.previousComputerId, computerId, origin.token],
                signal,
            );
    }
}

async function derivedToken(
    serverKey: IdentityOperations["credentialKey"],
    input: readonly string[],
    signal: AbortSignal,
) {
    const secret = await serverKey(signal);
    const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(input)));
    return `morty_computer_v1_${btoa(String.fromCharCode(...new Uint8Array(signed)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "")}`;
}
