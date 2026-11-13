import { PairingDirectoryError, type PairingStatus, parseAgents } from "./pairing.ts";
import type { PairingComputerRow } from "./pairing-records.ts";

export function computerRevokedAt(value: unknown): number | null {
    if (value === null) {
        return null;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new PairingDirectoryError("invalid_directory_record", "The Computer revocation is invalid");
    }
    return value;
}

// The v1 representation is a projection of facts. Passing the clock explicitly
// makes expiry independent of polling, maintenance writes, and component order.
export function computerPairingStatus(row: PairingComputerRow, computerId: string, now: number): PairingStatus {
    const revokedAt = computerRevokedAt(row.revoked_at);
    if (revokedAt !== null) {
        return { status: "revoked", revokedAt: new Date(revokedAt).toISOString() };
    }
    if (row.registration !== null) {
        return {
            status: "paired",
            agents: parseAgents(row.registration.agents_json),
            computerName: row.registration.computer_name,
            workspaceName: row.registration.workspace_name,
            computerId,
        };
    }
    if (!Number.isSafeInteger(row.expires_at) || row.expires_at < 0) {
        throw new PairingDirectoryError("invalid_directory_record", "The pairing deadline is invalid");
    }
    return row.expires_at <= now
        ? { status: "expired" }
        : { status: "pending", expiresAt: new Date(row.expires_at).toISOString() };
}
