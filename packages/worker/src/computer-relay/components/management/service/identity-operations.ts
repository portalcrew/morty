export interface IdentityOperations {
    readonly commitAccessEnd: (change: () => Promise<boolean>) => Promise<boolean>;
    readonly credentialKey: (signal: AbortSignal) => Promise<Uint8Array>;
}
