import { base64urlnopad } from "@scure/base";
import { z } from "zod";
import { computerEncryptionAccessCodec } from "./calls/encryption.ts";
import type { ComputerEncryptionAccess } from "./encryption.ts";
import { DIRECTORY_PATH } from "./protocol/shared/directory.ts";
import { identifierStringSchema, isIdentifier } from "./protocol/shared/identifier.ts";

export interface SetupHandoff {
    readonly code: string;
    readonly encryption: ComputerEncryptionAccess;
    readonly harness: string;
    readonly sessionId: string;
    readonly workspace: string;
}

export interface SetupHandoffLink {
    readonly computerId: string;
    readonly secret: string;
}

export interface SealedSetupHandoff {
    readonly url: string;
    readonly lookupId: string;
    readonly sealed: string;
}

export class SetupHandoffError extends Error {
    readonly code = "setup_handoff_invalid";

    constructor(options: ErrorOptions = {}) {
        super("This setup link is damaged.", options);
        this.name = "SetupHandoffError";
    }
}

export const sealedSetupHandoffFormat = "sealed-v1";
export const setupHandoffLookupIdPattern = /^[A-Za-z0-9_-]{22}$/u;
export const sealedSetupHandoffPattern = /^[A-Za-z0-9_-]{1,32768}$/u;

// 128 bits is the capability-URL floor, and every extra byte here widens the QR code.
const secretBytes = 16;
const secretPattern = /^[A-Za-z0-9_-]{22}$/u;
const ivBytes = 12;
const plaintextSchema = z
    .strictObject({
        version: z.literal(1),
        code: z.string().min(1).max(512),
        encryption: z.string().min(1).max(1_024),
        harness: identifierStringSchema,
        sessionId: identifierStringSchema,
        workspace: DIRECTORY_PATH,
    })
    .readonly();

async function keys(link: SetupHandoffLink) {
    const material = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(base64urlnopad.decode(link.secret)),
        "HKDF",
        false,
        ["deriveBits", "deriveKey"],
    );
    const derivation = (info: string) => ({
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new Uint8Array(new TextEncoder().encode(info)),
    });
    const lookupId = new Uint8Array(
        await crypto.subtle.deriveBits(derivation("morty setup handoff v1 lookup"), material, 128),
    );
    const key = await crypto.subtle.deriveKey(
        derivation("morty setup handoff v1 key"),
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
    return { lookupId: base64urlnopad.encode(lookupId), key };
}

function associatedData(computerId: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(new TextEncoder().encode(`morty setup handoff v1\0${computerId}`));
}

/**
 * Seals everything a setup link carries under a key only the link holds, so the link stays short enough for a
 * terminal QR code while the relay that stores the sealed handoff learns none of it.
 */
export async function sealSetupHandoff(
    origin: string,
    computerId: string,
    handoff: SetupHandoff,
): Promise<SealedSetupHandoff> {
    const plaintext = plaintextSchema.safeParse({
        version: 1,
        code: handoff.code,
        encryption: JSON.stringify(handoff.encryption),
        harness: handoff.harness,
        sessionId: handoff.sessionId,
        workspace: handoff.workspace,
    });
    if (!plaintext.success || !isIdentifier(computerId) || handoff.encryption.computerId !== computerId) {
        throw new SetupHandoffError(plaintext.success ? {} : { cause: plaintext.error });
    }
    const link = { computerId, secret: base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(secretBytes))) };
    const { lookupId, key } = await keys(link);
    const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: associatedData(computerId) },
            key,
            new Uint8Array(new TextEncoder().encode(JSON.stringify(plaintext.data))),
        ),
    );
    const sealed = new Uint8Array(iv.length + ciphertext.length);
    sealed.set(iv);
    sealed.set(ciphertext, iv.length);
    const url = new URL("/continue", origin);
    url.hash = `h=${link.computerId}.${link.secret}`;
    return { url: url.toString(), lookupId, sealed: base64urlnopad.encode(sealed) };
}

/** The sealed setup link in a `/continue` fragment, or null when the fragment carries another kind of link. */
export function readSetupHandoffLink(fragment: string): SetupHandoffLink | null {
    const value = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment).get("h");
    if (value === null) {
        return null;
    }
    const separator = value.lastIndexOf(".");
    const computerId = value.slice(0, separator);
    const secret = value.slice(separator + 1);
    return separator > 0 && isIdentifier(computerId) && secretPattern.test(secret) ? { computerId, secret } : null;
}

export async function setupHandoffLookupId(link: SetupHandoffLink): Promise<string> {
    return (await keys(link)).lookupId;
}

export async function openSetupHandoff(link: SetupHandoffLink, sealed: string): Promise<SetupHandoff> {
    try {
        const bytes = new Uint8Array(base64urlnopad.decode(sealed));
        const { key } = await keys(link);
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes.slice(0, ivBytes), additionalData: associatedData(link.computerId) },
            key,
            bytes.slice(ivBytes),
        );
        const handoff = plaintextSchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext)),
        );
        const encryption = computerEncryptionAccessCodec.decode(handoff.encryption);
        if (encryption.computerId !== link.computerId) {
            throw new Error("The sealed encryption access names another Computer.");
        }
        return {
            code: handoff.code,
            encryption,
            harness: handoff.harness,
            sessionId: handoff.sessionId,
            workspace: handoff.workspace,
        };
    } catch (cause) {
        throw new SetupHandoffError({ cause });
    }
}
