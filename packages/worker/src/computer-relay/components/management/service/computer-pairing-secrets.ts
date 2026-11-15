import { normalizePairingCode, validateToken } from "../../../../contracts/relay/pairing.ts";

const COMPUTER_PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function deriveSecret(secret: Uint8Array, computerId: string, idempotencyKey: string, purpose: string) {
    const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(secret),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
    );
    return new Uint8Array(
        await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(`${purpose}\u0000${computerId}\u0000${idempotencyKey}`),
        ),
    );
}

function encodeToken(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function deriveComputerDaemonToken(
    pairingCode: string,
    computerId: string,
    pollTokenHash: string,
): Promise<string> {
    // Keep this derivation stable across deployments. The stored poll verifier
    // is not exposed by claim/redeem, so the printed code alone cannot derive a
    // long-lived credential offline after the server's replay deadline.
    const bytes = await deriveSecret(
        new TextEncoder().encode(validateToken(pollTokenHash)),
        computerId,
        `${computerId}\u0000${normalizePairingCode(pairingCode)}`,
        "computer-daemon-token-v1",
    );
    return `${computerId}_${encodeToken(bytes)}`;
}

/** A pairing's secrets derive from the computer's durable key and its request, so a retry derives the same ones. */
export async function deriveComputerPairingSecrets(key: Uint8Array, computerId: string, idempotencyKey: string) {
    const codeBytes = await deriveSecret(key, computerId, idempotencyKey, "pairing-code");
    let code = "";
    for (const byte of codeBytes.slice(0, 20)) {
        code += COMPUTER_PAIRING_CODE_ALPHABET.charAt(byte % COMPUTER_PAIRING_CODE_ALPHABET.length);
    }
    return {
        pairingCode: code.match(/.{1,4}/g)?.join("-") ?? code,
        pollToken: encodeToken(await deriveSecret(key, computerId, idempotencyKey, "poll-token")),
    };
}
