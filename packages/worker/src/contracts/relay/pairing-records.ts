/** What presenting a Computer credential with its successor found, after any rotation it caused. */
export type ComputerCredentialRotation =
    /** The successor authenticates now: rotated just now, or by an earlier attempt whose reply was lost. */
    | { readonly kind: "rotated" }
    /** A credential an earlier rotation retired, presented with another successor: a copy is in use elsewhere. */
    | { readonly kind: "reused" }
    /** A credential of a Computer whose access has ended. */
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
