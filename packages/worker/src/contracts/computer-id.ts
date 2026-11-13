import type { ComputerLocationHint } from "./computer-location.ts";
import { ComputerManagementError } from "./computer-management.ts";
import type { ComputerManagementPlacement } from "./relay/computer-management.ts";

const placements: ReadonlyMap<string, ComputerManagementPlacement> = new Map([
    ["wn", { locationHint: "wnam" }],
    ["ap", { locationHint: "apac" }],
    ["an", { locationHint: "apac-ne" }],
    ["as", { locationHint: "apac-se" }],
]);

/** A fixed creation reference recovers its computer; a new reference always allocates another one. */
export async function accountComputerId(key: string, locationHint: ComputerLocationHint): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["morty-computer-v1", key]))),
    );
    const localId = btoa(String.fromCharCode(...digest.subarray(0, 18)))
        .replaceAll("+", "-")
        .replaceAll("/", "_");
    return encodeRelayComputerId({ locationHint }, localId);
}

/** Relay IDs contain a locally mapped shard code followed by a 144-bit local identifier. */
function encodeRelayComputerId(placement: ComputerManagementPlacement, localId: string): string {
    for (const [code, candidate] of placements) {
        if (candidate.locationHint === placement.locationHint) {
            return `prj_${code}_01_${localId}`;
        }
    }
    throw new ComputerManagementError(
        "storage_location_unavailable",
        "The requested storage location is unavailable",
        400,
    );
}

export function decodeComputerPlacement(computerId: string): ComputerManagementPlacement | null {
    const match = /^prj_(wn|ap|an|as)_01_([A-Za-z0-9_-]{24})$/.exec(computerId);
    const code = match?.[1];
    if (match?.[0] !== computerId || code === undefined) {
        return null;
    }
    return placements.get(code) ?? null;
}

export function computerIdFromPrefixedValue(value: string): string | null {
    const match = /(?:^|_)(prj_(?:wn|ap|an|as)_01_[A-Za-z0-9_-]{24})(?:[._]|$)/.exec(value);
    const computerId = match?.[1];
    return computerId !== undefined && decodeComputerPlacement(computerId) !== null ? computerId : null;
}

/**
 * The name of the Durable Object that owns a computer's storage. Its version is part of the name, so raising it
 * starts every computer on a fresh object instead of reinterpreting storage written under an earlier layout.
 */
export function computerObjectName(computerId: string): string {
    return `v2/${computerId}`;
}
