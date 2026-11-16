export interface ComputerConnectionIdentity {
    readonly connectionEpoch: number;
}

export interface ComputerConnection {
    readonly connectionEpoch: number;
    readonly generation: number;
    readonly connectedAt: number;
}

export type LatestComputerConnection =
    | (ComputerConnection & { readonly kind: "connected" })
    | (ComputerConnection & { readonly kind: "disconnected"; readonly disconnectedAt: number });
