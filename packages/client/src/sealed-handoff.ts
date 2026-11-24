import { base64urlnopad } from "@scure/base";
import { z } from "zod";
import { computerEncryptionAccessCodec } from "./calls/encryption.ts";
import type { ComputerEncryptionAccess } from "./encryption.ts";
import { DIRECTORY_PATH } from "./protocol/shared/directory.ts";
import { identifierStringSchema, isIdentifier } from "./protocol/shared/identifier.ts";

interface AccessHandoff {
    readonly code: string;
    readonly encryption: ComputerEncryptionAccess;
}

export interface SetupHandoff extends AccessHandoff {
    readonly harness: string;
    readonly sessionId: string;
    readonly workspace: string;
}

export type SealedHandoff =
    | { readonly kind: "setup"; readonly handoff: SetupHandoff }
    | { readonly kind: "access"; readonly handoff: AccessHandoff };

export interface SealedHandoffLink {
    readonly kind: SealedHandoff["kind"];
    readonly computerId: string;
    readonly secret: string;
}

export interface SealedHandoffLinkIssue {
    readonly url: string;
    readonly lookupId: string;
    readonly sealed: string;
}

export class SealedHandoffError extends Error {
    readonly code = "sealed_handoff_invalid";

    constructor(options: ErrorOptions = {}) {
        super("This link is damaged.", options);
        this.name = "SealedHandoffError";
    }
}

/** The formats a Worker names in `setupHandoffFormats` once the `/continue` page it serves opens them. */
export const sealedSetupHandoffFormat = "sealed-v1";
export const sealedAccessHandoffFormat = "sealed-access-v1";
export const sealedHandoffLookupIdPattern = /^[A-Za-z0-9_-]{22}$/u;
export const sealedHandoffPattern = /^[A-Za-z0-9_-]{1,32768}$/u;

// 128 bits is the capability-URL floor, and every extra byte here widens the QR code.
const secretBytes = 16;
const secretPattern = /^[A-Za-z0-9_-]{22}$/u;
const ivBytes = 12;
const accessPlaintextShape = {
    version: z.literal(1),
    code: z.string().min(1).max(512),
    encryption: z.string().min(1).max(1_024),
};
const accessPlaintextSchema = z.strictObject(accessPlaintextShape).readonly();
const setupPlaintextSchema = z
    .strictObject({
        ...accessPlaintextShape,
        harness: identifierStringSchema,
        sessionId: identifierStringSchema,
        workspace: DIRECTORY_PATH,
    })
    .readonly();

// Each kind derives its own keys and binds its own associated data, so contents sealed as one kind never open as
// another. The setup labels are those released setup links were sealed with.
const kinds = {
    setup: { fragment: "h", label: "morty setup handoff v1" },
    access: { fragment: "a", label: "morty access handoff v1" },
} as const satisfies Record<SealedHandoff["kind"], { readonly fragment: string; readonly label: string }>;

async function keys(link: SealedHandoffLink) {
    const { label } = kinds[link.kind];
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
    const lookupId = new Uint8Array(await crypto.subtle.deriveBits(derivation(`${label} lookup`), material, 128));
    const key = await crypto.subtle.deriveKey(
        derivation(`${label} key`),
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
    return { lookupId: base64urlnopad.encode(lookupId), key };
}

function associatedData(link: SealedHandoffLink): Uint8Array<ArrayBuffer> {
    return new Uint8Array(new TextEncoder().encode(`${kinds[link.kind].label}\0${link.computerId}`));
}

function plaintext(sealed: SealedHandoff) {
    const access = {
        version: 1,
        code: sealed.handoff.code,
        encryption: JSON.stringify(sealed.handoff.encryption),
    };
    switch (sealed.kind) {
        case "setup":
            return setupPlaintextSchema.safeParse({
                ...access,
                harness: sealed.handoff.harness,
                sessionId: sealed.handoff.sessionId,
                workspace: sealed.handoff.workspace,
            });
        case "access":
            return accessPlaintextSchema.safeParse(access);
    }
}

/**
 * Seals everything a link carries under a key only the link holds, so the link stays short enough for a QR code
 * while the relay that stores the sealed contents learns none of them.
 */
export async function sealHandoff(
    origin: string,
    computerId: string,
    sealed: SealedHandoff,
): Promise<SealedHandoffLinkIssue> {
    const contents = plaintext(sealed);
    if (!contents.success || !isIdentifier(computerId) || sealed.handoff.encryption.computerId !== computerId) {
        throw new SealedHandoffError(contents.success ? {} : { cause: contents.error });
    }
    const link: SealedHandoffLink = {
        kind: sealed.kind,
        computerId,
        secret: base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(secretBytes))),
    };
    const { lookupId, key } = await keys(link);
    const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: associatedData(link) },
            key,
            new Uint8Array(new TextEncoder().encode(JSON.stringify(contents.data))),
        ),
    );
    const bytes = new Uint8Array(iv.length + ciphertext.length);
    bytes.set(iv);
    bytes.set(ciphertext, iv.length);
    const url = new URL("/continue", origin);
    url.hash = `${kinds[link.kind].fragment}=${link.computerId}.${link.secret}`;
    return { url: url.toString(), lookupId, sealed: base64urlnopad.encode(bytes) };
}

/** The sealed link in a `/continue` fragment, or null when the fragment carries another kind of link. */
export function readSealedHandoffLink(fragment: string): SealedHandoffLink | null {
    const parameters = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
    const present = (["setup", "access"] as const).flatMap((kind) => {
        const value = parameters.get(kinds[kind].fragment);
        return value === null ? [] : [{ kind, value }];
    });
    const [only] = present;
    if (only === undefined || present.length !== 1) {
        return null;
    }
    const separator = only.value.lastIndexOf(".");
    const computerId = only.value.slice(0, separator);
    const secret = only.value.slice(separator + 1);
    return separator > 0 && isIdentifier(computerId) && secretPattern.test(secret)
        ? { kind: only.kind, computerId, secret }
        : null;
}

export async function sealedHandoffLookupId(link: SealedHandoffLink): Promise<string> {
    return (await keys(link)).lookupId;
}

export async function openSealedHandoff(link: SealedHandoffLink, sealed: string): Promise<SealedHandoff> {
    try {
        const bytes = new Uint8Array(base64urlnopad.decode(sealed));
        const { key } = await keys(link);
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes.slice(0, ivBytes), additionalData: associatedData(link) },
            key,
            bytes.slice(ivBytes),
        );
        const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decrypted),
        );
        const access = (contents: { readonly code: string; readonly encryption: string }): AccessHandoff => {
            const encryption = computerEncryptionAccessCodec.decode(contents.encryption);
            if (encryption.computerId !== link.computerId) {
                throw new Error("The sealed encryption access names another Computer.");
            }
            return { code: contents.code, encryption };
        };
        switch (link.kind) {
            case "setup": {
                const contents = setupPlaintextSchema.parse(value);
                return {
                    kind: "setup",
                    handoff: {
                        ...access(contents),
                        harness: contents.harness,
                        sessionId: contents.sessionId,
                        workspace: contents.workspace,
                    },
                };
            }
            case "access":
                return { kind: "access", handoff: access(accessPlaintextSchema.parse(value)) };
        }
    } catch (cause) {
        throw new SealedHandoffError({ cause });
    }
}
