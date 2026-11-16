export interface ComputerCredentialRotation {
    readonly current: string;
    readonly successor: string;
}

export interface HeldComputerCredentials {
    readonly current: string;
    readonly successor: string | null;
}

/**
 * A Computer's relay credential, which rotates on every connection. `prepare` saves the successor before any
 * connection presents it, so a crash or a lost reply repeats the same rotation instead of starting another, and
 * `complete` records that the Relay accepted it. A copy of a retired credential then reaches nothing.
 */
export interface ComputerCredentials {
    readonly prepare: (signal: AbortSignal) => Promise<ComputerCredentialRotation>;
    readonly complete: (rotation: ComputerCredentialRotation, signal: AbortSignal) => Promise<void>;
    /**
     * What a request presents. While a connection's rotation is being saved the Relay already holds the successor
     * as current, so a request presents both and the Relay accepts the one it holds.
     */
    readonly held: (signal: AbortSignal) => Promise<HeldComputerCredentials>;
}
