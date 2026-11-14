import { z } from "zod";
import { identifierStringSchema } from "../../shared/identifier.ts";
import { ProtocolMessageError } from "../../shared/message-codec.ts";
import { nativeSessionTargetSchema } from "../shared/native-session-target.ts";

const SESSION_ACCESS_PATTERN = /^msession_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u;

/** Whose access a Session credential carries: a browser device's, or the computer's local or recovery credential's. */
const sessionAccessHolderSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("device"), deviceId: identifierStringSchema }).readonly(),
    z.strictObject({ kind: z.literal("credential"), credentialId: identifierStringSchema }).readonly(),
]);

export type SessionAccessHolder = z.infer<typeof sessionAccessHolderSchema>;

/**
 * The access a Session credential carries: whose access, under which of the computer's Runtime pairing generations.
 * The credential is honored only while that holder's access holds and that generation is still the computer's active
 * one, so ending either ends the credential without any record of its own.
 */
const sessionAccessGrantSchema = z
    .strictObject({
        holder: sessionAccessHolderSchema,
        generation: z.number().int().positive(),
    })
    .readonly();

export type SessionAccessGrant = z.infer<typeof sessionAccessGrantSchema>;

const claimsSchema = z
    .object({
        expiresAtEpochMilliseconds: z.number().int().nonnegative(),
        issuedAtEpochMilliseconds: z.number().int().nonnegative(),
        computerId: identifierStringSchema,
        purpose: z.literal("session-access"),
        grant: sessionAccessGrantSchema,
        target: nativeSessionTargetSchema,
    })
    .readonly();

export type SessionAccessClaims = z.infer<typeof claimsSchema>;

export interface SessionAccessCredential {
    readonly claims: SessionAccessClaims;
    readonly signature: ArrayBuffer;
    readonly signedValue: string;
}

function decodeBase64Url(value: string): Uint8Array {
    try {
        const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
        const binary = atob(padded);
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch (cause) {
        throw new ProtocolMessageError("The Session credential is invalid", { cause });
    }
}

function exactBuffer(value: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(value.byteLength);
    new Uint8Array(buffer).set(value);
    return buffer;
}

export function decodeSessionAccessCredential(credential: string): SessionAccessCredential {
    const match = SESSION_ACCESS_PATTERN.exec(credential);
    const payload = match?.[1];
    const encodedSignature = match?.[2];
    if (payload === undefined || encodedSignature === undefined) {
        throw new ProtocolMessageError("The Session credential is invalid");
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    } catch (cause) {
        throw new ProtocolMessageError("The Session credential is invalid", { cause });
    }
    const parsed = claimsSchema.safeParse(decoded);
    if (!parsed.success) {
        throw new ProtocolMessageError("The Session credential is invalid", { cause: parsed.error });
    }
    return {
        claims: parsed.data,
        signature: exactBuffer(decodeBase64Url(encodedSignature)),
        signedValue: `msession_${payload}`,
    };
}
