import type { AgentDescriptor } from "./pairing.ts";

export type ComputerCredentialRotation =
    | { readonly kind: "rotated" }
    | { readonly kind: "reused" }
    | { readonly kind: "revoked" }
    | { readonly kind: "unknown" };

interface ComputerRegistrationRow {
    readonly computer_name: string;
    readonly workspace_name: string;
}

export interface PairingComputerRow {
    readonly expires_at: number;
    readonly revoked_at: number | null;
    readonly registration: ComputerRegistrationRow | null;
    readonly agents: readonly AgentDescriptor[] | null;
}

export interface PairingClaimRow extends PairingComputerRow {
    readonly poll_token_hash: string;
}

export interface ComputerPairingRow {
    readonly pairing_code_hash: string;
    readonly poll_token_hash: string;
    readonly expires_at: number;
}
