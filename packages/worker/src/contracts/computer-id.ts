// The prefix no longer selects a Relay location. Released Workers and open pages accept only these values, and a
// replacement keeps its predecessor's prefix so every Worker version derives the same successor.
const computerIdPrefixes = ["wn", "ap", "an", "as"] as const;
type ComputerIdPrefix = (typeof computerIdPrefixes)[number];
const computerIdPattern = `prj_(${computerIdPrefixes.join("|")})_01_[A-Za-z0-9_-]{24}`;
const computerIdExpression = new RegExp(`^${computerIdPattern}$`, "u");
const prefixedComputerIdExpression = new RegExp(`(?:^|_)(${computerIdPattern})(?:[._]|$)`, "u");

export async function accountComputerId(key: string, prefix: ComputerIdPrefix = "ap"): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["morty-computer-v1", key]))),
    );
    const localId = btoa(String.fromCharCode(...digest.subarray(0, 18)))
        .replaceAll("+", "-")
        .replaceAll("/", "_");
    return `prj_${prefix}_01_${localId}`;
}

export function computerIdPrefix(computerId: string): ComputerIdPrefix | null {
    const code = computerIdExpression.exec(computerId)?.[1];
    return computerIdPrefixes.find((prefix) => prefix === code) ?? null;
}

export function computerIdFromPrefixedValue(value: string): string | null {
    return prefixedComputerIdExpression.exec(value)?.[1] ?? null;
}

/**
 * The name of the Durable Object that owns a computer's storage. Its version is part of the name, so raising it
 * starts every computer on a fresh object instead of reinterpreting storage written under an earlier layout.
 */
export function computerObjectName(computerId: string): string {
    return `v2/${computerId}`;
}
