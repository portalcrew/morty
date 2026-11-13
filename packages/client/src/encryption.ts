import { base64urlnopad } from "@scure/base";
import { MortyError } from "./errors.ts";

const encoder = new TextEncoder();
const P256_PUBLIC_KEY_BYTES = 65;
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const MAX_PAYLOAD_PACKET_BYTES = 1 + 8 + 12 + MAX_PLAINTEXT_BYTES + 16;
const MAX_ASSOCIATED_DATA_BYTES = 32 * 1024;

export type E2EErrorCode =
    | "e2e_invalid_frame"
    | "e2e_authentication_failed"
    | "e2e_channel_closed"
    | "e2e_invalid_key"
    | "e2e_invalid_access"
    | "e2e_store_unavailable"
    | "e2e_store_busy"
    | "e2e_access_denied";

export class E2EError extends MortyError {
    constructor(code: E2EErrorCode, options: ErrorOptions = {}) {
        super(code, "The encrypted channel could not process the message", options);
        this.name = "E2EError";
    }
}

export interface E2EIdentity {
    readonly publicKey: CryptoKey;
    readonly privateKey: CryptoKey;
}

/** Local setup hands Computer-scoped access to a browser in a URL fragment, never through the Worker. */
export interface ComputerEncryptionAccess {
    readonly computerId: string;
    readonly computerE2EPublicKey: string;
    readonly computerE2EAccessSecret: string;
}

export async function exportE2EPublicKey(key: CryptoKey): Promise<string> {
    try {
        validateKey(key, "public");
        const exported: unknown = await crypto.subtle.exportKey("raw", key);
        if (!(exported instanceof ArrayBuffer)) {
            throw new E2EError("e2e_invalid_key");
        }
        const bytes = new Uint8Array(exported);
        if (bytes.byteLength !== P256_PUBLIC_KEY_BYTES) {
            throw new E2EError("e2e_invalid_key");
        }
        return encodeBytes(bytes);
    } catch (cause) {
        throw new E2EError("e2e_invalid_key", { cause });
    }
}

export async function importE2EPublicKey(encoded: string): Promise<CryptoKey> {
    try {
        const bytes = decodeBytes(encoded);
        if (bytes.byteLength !== P256_PUBLIC_KEY_BYTES) {
            throw new E2EError("e2e_invalid_key");
        }
        return await crypto.subtle.importKey("raw", bytes, { name: "ECDH", namedCurve: "P-256" }, true, []);
    } catch (cause) {
        throw new E2EError("e2e_invalid_key", { cause });
    }
}

export interface PayloadEncryptor {
    readonly encrypt: (plaintext: Uint8Array, associatedData: Uint8Array, signal: AbortSignal) => Promise<string>;
}

export interface PayloadDecryptor {
    readonly decrypt: (ciphertext: string, associatedData: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
}

export interface PayloadEncryptionConnection extends PayloadEncryptor, PayloadDecryptor {
    readonly close: () => void;
}

export async function createClientPayloadEncryption(
    access: ComputerEncryptionAccess,
    signal: AbortSignal,
): Promise<PayloadEncryptionConnection> {
    return createPayloadEncryption(access, { kind: "client" }, signal);
}

export async function generateE2EIdentity(): Promise<E2EIdentity> {
    // Public keys remain exportable; private keys can be persisted as CryptoKeys without exporting their material.
    const generated = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    if (!("privateKey" in generated) || !("publicKey" in generated)) {
        throw new E2EError("e2e_invalid_key");
    }
    return { privateKey: generated.privateKey, publicKey: generated.publicKey };
}

function encodeBytes(bytes: Uint8Array): string {
    return base64urlnopad.encode(bytes);
}

function decodeBytes(encoded: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length > Math.ceil(MAX_PAYLOAD_PACKET_BYTES / 3) * 4) {
        throw new E2EError("e2e_invalid_frame");
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = new Uint8Array(base64urlnopad.decode(encoded));
    } catch (cause) {
        throw new E2EError("e2e_invalid_frame", { cause });
    }
    if (encodeBytes(bytes) !== encoded) {
        throw new E2EError("e2e_invalid_frame");
    }
    return bytes;
}

const BOX_VERSION = 3;
const BOX_HEADER_BYTES = 1 + 8 + 12;
export const PAYLOAD_MAX_AGE_MILLISECONDS = 240_000;
export const PAYLOAD_FUTURE_SKEW_MILLISECONDS = 30_000;
const MAX_SEEN_BOXES = 65_536;

export interface PayloadClaim {
    readonly fingerprint: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
}

type PayloadRole =
    | { readonly kind: "client" }
    | { readonly kind: "computer"; readonly claim: (claim: PayloadClaim, signal: AbortSignal) => Promise<void> };

export async function createComputerPayloadEncryption(
    access: ComputerEncryptionAccess,
    claim: (claim: PayloadClaim, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
): Promise<PayloadEncryptionConnection> {
    return createPayloadEncryption(access, { kind: "computer", claim }, signal);
}

async function createPayloadEncryption(
    access: ComputerEncryptionAccess,
    role: PayloadRole,
    signal: AbortSignal,
): Promise<PayloadEncryptionConnection> {
    signal.throwIfAborted();
    const secret = decodeBytes(access.computerE2EAccessSecret);
    if (secret.byteLength !== 32 || access.computerId.length === 0) {
        throw new E2EError("e2e_invalid_access");
    }
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: encoder.encode(access.computerId),
            info: encoder.encode("morty.e2e.payload.aes256gcm.v1"),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
    signal.throwIfAborted();
    const seen = new Map<string, number>();
    const pending = new Set<string>();
    let capacityProbe = false;
    let replayClock = 0;
    let nextExpiry = Number.POSITIVE_INFINITY;
    let closed = false;
    const aad = (header: Uint8Array, direction: "client" | "computer", value: Uint8Array): Uint8Array<ArrayBuffer> => {
        if (value.byteLength > MAX_ASSOCIATED_DATA_BYTES) {
            throw new E2EError("e2e_invalid_frame");
        }
        const prefix = encoder.encode(`morty-e2e-payload-v3:${direction}:`);
        const result = new Uint8Array(prefix.length + header.length + value.length);
        result.set(prefix);
        result.set(header, prefix.length);
        result.set(value, prefix.length + header.length);
        return result;
    };
    return {
        close: () => {
            closed = true;
            seen.clear();
            pending.clear();
        },
        encrypt: async (plaintext, associatedData, operationSignal) => {
            operationSignal.throwIfAborted();
            if (closed) {
                throw new E2EError("e2e_channel_closed");
            }
            if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
                throw new E2EError("e2e_invalid_frame");
            }
            const header = new Uint8Array(BOX_HEADER_BYTES);
            header[0] = BOX_VERSION;
            new DataView(header.buffer).setBigUint64(1, BigInt(Date.now()));
            crypto.getRandomValues(header.subarray(9));
            const payload = new Uint8Array(plaintext);
            const authenticated = aad(header, role.kind, associatedData);
            try {
                const ciphertext = new Uint8Array(
                    await crypto.subtle.encrypt(
                        { name: "AES-GCM", iv: header.slice(9), additionalData: authenticated },
                        key,
                        payload,
                    ),
                );
                operationSignal.throwIfAborted();
                if (closed) {
                    throw new E2EError("e2e_channel_closed");
                }
                const packet = new Uint8Array(header.length + ciphertext.length);
                packet.set(header);
                packet.set(ciphertext, header.length);
                return encodeBytes(packet);
            } catch (cause) {
                operationSignal.throwIfAborted();
                if (cause instanceof E2EError) {
                    throw cause;
                }
                throw new E2EError("e2e_authentication_failed", { cause });
            }
        },
        decrypt: async (encoded, associatedData, operationSignal) => {
            operationSignal.throwIfAborted();
            if (closed) {
                throw new E2EError("e2e_channel_closed");
            }
            const packet = decodeBytes(encoded);
            if (
                packet.length < BOX_HEADER_BYTES + 16 ||
                packet.length > BOX_HEADER_BYTES + MAX_PLAINTEXT_BYTES + 16 ||
                packet[0] !== BOX_VERSION
            ) {
                throw new E2EError("e2e_invalid_frame");
            }
            const header = packet.slice(0, BOX_HEADER_BYTES);
            const timestamp = new DataView(header.buffer).getBigUint64(1);
            if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new E2EError("e2e_invalid_frame");
            }
            const issuedAt = Number(timestamp);
            const expiresAt = issuedAt + PAYLOAD_MAX_AGE_MILLISECONDS;
            const now = Math.max(Date.now(), replayClock);
            replayClock = now;
            if (issuedAt > now + PAYLOAD_FUTURE_SKEW_MILLISECONDS || expiresAt <= now) {
                throw new E2EError("e2e_invalid_frame");
            }
            if (now >= nextExpiry) {
                nextExpiry = Number.POSITIVE_INFINITY;
                for (const [nonce, retainedUntil] of seen) {
                    if (retainedUntil <= now) {
                        seen.delete(nonce);
                    } else {
                        nextExpiry = Math.min(nextExpiry, retainedUntil);
                    }
                }
            }
            const packetId = encodeBytes(header.subarray(9));
            if (seen.has(packetId) || pending.has(packetId)) {
                throw new E2EError("e2e_invalid_frame");
            }
            const atCapacity = seen.size + pending.size >= MAX_SEEN_BOXES;
            if (atCapacity && capacityProbe) {
                throw new E2EError("e2e_invalid_frame");
            }
            if (atCapacity) {
                capacityProbe = true;
            } else {
                pending.add(packetId);
            }
            try {
                const authenticated = aad(header, role.kind === "client" ? "computer" : "client", associatedData);
                const plaintext = new Uint8Array(
                    await crypto.subtle.decrypt(
                        { name: "AES-GCM", iv: header.slice(9), additionalData: authenticated },
                        key,
                        packet.subarray(BOX_HEADER_BYTES),
                    ),
                );
                operationSignal.throwIfAborted();
                if (closed) {
                    throw new E2EError("e2e_channel_closed");
                }
                if (atCapacity) {
                    throw new E2EError("e2e_store_busy");
                }
                if (role.kind === "computer") {
                    const fingerprint = encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", packet)));
                    await role.claim({ fingerprint, issuedAt, expiresAt }, operationSignal);
                }
                operationSignal.throwIfAborted();
                if (closed) {
                    throw new E2EError("e2e_channel_closed");
                }
                replayClock = Math.max(Date.now(), replayClock);
                if (expiresAt <= replayClock) {
                    throw new E2EError("e2e_invalid_frame");
                }
                const retainedUntil = expiresAt + PAYLOAD_FUTURE_SKEW_MILLISECONDS;
                seen.set(packetId, retainedUntil);
                nextExpiry = Math.min(nextExpiry, retainedUntil);
                return plaintext;
            } catch (cause) {
                operationSignal.throwIfAborted();
                if (cause instanceof E2EError) {
                    throw cause;
                }
                throw new E2EError("e2e_authentication_failed", { cause });
            } finally {
                if (atCapacity) {
                    capacityProbe = false;
                } else {
                    pending.delete(packetId);
                }
            }
        },
    };
}

function validateKey(key: CryptoKey, type: "private" | "public"): void {
    if (key.type !== type || key.algorithm.name !== "ECDH" || Reflect.get(key.algorithm, "namedCurve") !== "P-256") {
        throw new E2EError("e2e_invalid_key");
    }
}
