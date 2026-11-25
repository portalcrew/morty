import type { CreationOrigin } from "../../../../contracts/computer-creation.ts";
import { accountComputerId, computerRegionFromId } from "../../../../contracts/computer-id.ts";
import { ComputerManagementError } from "../../../../contracts/computer-management.ts";
import { ManagementError } from "../../../../contracts/management-error.ts";
import type { ComputerIdentity } from "../entity/computer-identity.ts";
import type { JoiningDevice } from "../storage/identity-storage.ts";
import { type AnonymousIdentity, digest, randomSecret } from "../storage/identity-storage-common.ts";
import type { AuthenticationService } from "./authentication-service.ts";
import type { IdentityOperations } from "./identity-operations.ts";
import type { LocalComputerService } from "./local-computer-service.ts";

export class ManagementService {
    readonly #authentication: AuthenticationService;
    readonly #computerId: string;
    readonly #relay: LocalComputerService;
    readonly #credentialKey: IdentityOperations["credentialKey"];

    constructor(cx: {
        readonly identity: ComputerIdentity;
        readonly identityOperations: IdentityOperations;
        readonly services: {
            readonly authentication: AuthenticationService;
            readonly computers: LocalComputerService;
        };
    }) {
        this.#authentication = cx.services.authentication;
        this.#computerId = cx.identity.computerId;
        this.#relay = cx.services.computers;
        this.#credentialKey = cx.identityOperations.credentialKey;
    }

    readonly readComputer = async (computerId: string, signal: AbortSignal) => {
        const computer = await this.findComputer(computerId, signal);
        if (computer === null) {
            throw new ManagementError("BOT_NOT_FOUND", "Computer is unavailable.", 404);
        }
        return { computerPairing: await this.#relay.readComputerPairing(signal) };
    };

    readonly findComputer = async (computerId: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        return this.#computerId !== computerId ? null : { computerId: this.#computerId };
    };

    /** The successor the previous Computer names, so every retry of its replacement creates the same computer. */
    readonly replaceComputer = async (computerId: string, signal: AbortSignal) => {
        const previous = await this.findComputer(computerId, signal);
        if (previous === null) {
            throw new ComputerManagementError("COMPUTER_REQUIRED", "Finish Morty setup before replacing.", 409);
        }
        // The predecessor fixes the successor's creation identity, so retries reach the same computer.
        const reference = `replacement_${previous.computerId}`;
        const region = computerRegionFromId(previous.computerId);
        if (region === null) {
            throw new ComputerManagementError("INVALID_ACCOUNT_ID", "The Computer ID is invalid.", 400);
        }
        const successorId = await accountComputerId(reference, region);
        signal.throwIfAborted();
        return { computerId: successorId };
    };

    readonly createComputerPairing = async (computerId: string, idempotencyKey: string, signal: AbortSignal) => {
        await this.#requireComputer(computerId, signal);
        return await this.#relay.createPairing(idempotencyKey, signal);
    };

    readonly readComputerPairing = async (computerId: string, signal: AbortSignal) => {
        await this.#requireComputer(computerId, signal);
        return await this.#relay.readPairing(signal);
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
    };
}

/**
 * Creates the computer this object holds with its owner's credential. `commitOwner` stores the computer's existence and
 * the credential as one transaction and reports whether the credential holds access, so a computer never exists without
 * its owner. Repeating a replacement derives the same credential and answers it again; a revoked one is never reissued.
 */
export async function createComputer(
    serverKey: IdentityOperations["credentialKey"],
    commitOwner: (tokenHash: string) => boolean,
    computerId: string,
    origin: CreationOrigin,
    signal: AbortSignal,
): Promise<AnonymousIdentity> {
    const token = await creationToken(serverKey, computerId, origin, signal);
    const tokenHash = await digest(token);
    signal.throwIfAborted();
    if (!commitOwner(tokenHash)) {
        throw new ManagementError("LOCAL_CREDENTIAL_UNAVAILABLE", "The credential is no longer available.", 409);
    }
    return { computerToken: token, computerId };
}

/**
 * The credential a creation issues. A created computer is created only by the request that names it, so its credential
 * is new; a replacement's derives from its origin, so repeating the replacement issues it again.
 */
async function creationToken(
    serverKey: IdentityOperations["credentialKey"],
    computerId: string,
    origin: CreationOrigin,
    signal: AbortSignal,
) {
    switch (origin.kind) {
        case "created":
            return `morty_computer_v1_${randomSecret()}`;
        case "replacement":
            // The version and input encoding are part of the persisted retry contract; keep them stable.
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
