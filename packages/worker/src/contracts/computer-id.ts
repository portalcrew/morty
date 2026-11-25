import { type ComputerRegionCode, computerRegionCodes } from "./computer-location.ts";

export async function accountComputerId(key: string, region: ComputerRegionCode): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["morty-computer-v1", key]))),
    );
    const localId = btoa(String.fromCharCode(...digest.subarray(0, 18)))
        .replaceAll("+", "-")
        .replaceAll("/", "_");
    return `prj_${region}_01_${localId}`;
}

export function computerRegionFromId(computerId: string): ComputerRegionCode | null {
    const match = /^prj_([a-z]{2})_01_[A-Za-z0-9_-]{24}$/u.exec(computerId);
    if (match?.[0] !== computerId) {
        return null;
    }
    return computerRegionCodes.find((code) => code === match[1]) ?? null;
}

export function computerIdFromPrefixedValue(value: string): string | null {
    const match = /(?:^|_)(prj_(?:wn|ap|an|as)_01_[A-Za-z0-9_-]{24})(?:[._]|$)/.exec(value);
    const computerId = match?.[1];
    return computerId !== undefined && computerRegionFromId(computerId) !== null ? computerId : null;
}

/**
 * The name of the Durable Object that owns a computer's storage. Its version is part of the name, so raising it
 * starts every computer on a fresh object instead of reinterpreting storage written under an earlier layout.
 */
export function computerObjectName(computerId: string): string {
    return `v2/${computerId}`;
}
