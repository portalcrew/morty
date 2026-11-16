export type ComputerCredentialRotation =
    | { readonly kind: "rotated" }
    | { readonly kind: "reused" }
    | { readonly kind: "revoked" }
    | { readonly kind: "unknown" };

export interface ComputerDirectoryRow {
    readonly agents_json: string;
    readonly computer_name: string;
    readonly workspace_name: string;
}

export interface ComputerPairingDirectoryRow {
    readonly revoked_at: number | null;
    readonly registration: ComputerDirectoryRow | null;
}

export interface PairingComputerRow extends ComputerPairingDirectoryRow {
    readonly expires_at: number;
}

export interface PairingClaimRow extends PairingComputerRow {
    readonly poll_token_hash: string;
}

export interface ComputerPairingRow {
    readonly pairing_code_hash: string;
    readonly poll_token_hash: string;
    readonly expires_at: number;
}
