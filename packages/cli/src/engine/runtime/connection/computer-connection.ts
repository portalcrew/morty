import type { HeldComputerCredentials } from "./computer-credentials.ts";

export interface ComputerConnectionInput {
    readonly computerId: string;
    readonly defaultWorkspace: string;
    readonly relayOrigin: URL;
    readonly computerCredential: string;
}

export class SavedComputerConnection {
    /** The relay revoked this pairing; it never connects again, and only a new pairing replaces it. */
    readonly revoked: boolean;
    readonly computerId: string;
    readonly pairingGeneration: string;
    readonly defaultWorkspace: string;
    readonly relayOrigin: URL;
    readonly credentials: HeldComputerCredentials;

    constructor(
        revoked: boolean,
        pairingGeneration: string,
        computerId: string,
        defaultWorkspace: string,
        relayOrigin: URL,
        credentials: HeldComputerCredentials,
    ) {
        this.revoked = revoked;
        this.computerId = computerId;
        this.pairingGeneration = pairingGeneration;
        this.defaultWorkspace = defaultWorkspace;
        this.relayOrigin = relayOrigin;
        this.credentials = credentials;
    }
}
