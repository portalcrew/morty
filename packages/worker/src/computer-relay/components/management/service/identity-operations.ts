export interface IdentityOperations {
    readonly commitAccessEnd: (change: () => Promise<boolean>) => Promise<boolean>;
    readonly credentialKey: (signal: AbortSignal) => Promise<Uint8Array>;
    /** A device joined through a link; followers of the linked devices read them again. */
    readonly linkedDevicesChanged: () => void;
}
