import type { HeldComputerCredentials } from "./computer-credentials.ts";

export interface ComputerConnectionInput {
    readonly computerId: string;
    readonly defaultWorkspace: string;
    readonly relayOrigin: URL;
    readonly computerCredential: string;
}

/** A saved pairing: the identity a Computer presents to the relay, and whether the relay revoked it. */
export class SavedComputerConnection {
    /** The relay revoked this pairing; it never connects again, and only a new pairing replaces it. */
    readonly revoked: boolean;
    readonly computerId: string;
    /** Fences work from an earlier pairing, even when this computer is paired again with the same identity. */
    readonly pairingGeneration: string;
    readonly defaultWorkspace: string;
    readonly relayOrigin: URL;
    /** The credential state saved with this pairing; live users read it through the installation store. */
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
