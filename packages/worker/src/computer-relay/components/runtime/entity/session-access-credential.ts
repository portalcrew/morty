import {
    decodeSessionAccessCredential,
    ProtocolMessageError,
    type SessionAccessClaims,
} from "@portalcrew/morty-client/protocol";
import { ComputerAuthenticationError } from "../../../../contracts/relay/computer-authentication.ts";

const SIGNING_SECRET_MINIMUM_LENGTH = 32;
const MAXIMUM_LIFETIME_MILLISECONDS = 15 * 60 * 1_000;
const MAXIMUM_ISSUANCE_CLOCK_SKEW_MILLISECONDS = 30_000;
const HMAC_SHA_256 = { hash: "SHA-256", name: "HMAC" } as const;

export class SessionAccessCredentialExpiredError extends ProtocolMessageError {
    constructor(expiredByMilliseconds: number) {
        super(`The Session credential expired ${expiredByMilliseconds} milliseconds ago`);
        this.name = "SessionAccessCredentialExpiredError";
    }
}

function encodeBase64Url(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * The dedicated deployment signing key never enters storage or the browser. Reading account records cannot forge
 * a Session credential; every credential binds its own purpose, target and deadline.
 */
export class SessionAccessSigner {
    readonly #secret: string;

    constructor(secret: string) {
        if (typeof secret !== "string" || secret.length < SIGNING_SECRET_MINIMUM_LENGTH) {
            throw new ComputerAuthenticationError(
                "relay_configuration_invalid",
                "The Session credential signing secret is invalid",
            );
        }
        this.#secret = secret;
    }

    readonly issue = async (claims: SessionAccessClaims): Promise<string> => {
        const lifetimeMilliseconds = claims.expiresAtEpochMilliseconds - claims.issuedAtEpochMilliseconds;
        if (lifetimeMilliseconds <= 0 || lifetimeMilliseconds > MAXIMUM_LIFETIME_MILLISECONDS) {
            throw new ProtocolMessageError("The Session credential lifetime is invalid");
        }
        const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
        const signedValue = `msession_${payload}`;
        const signature = await crypto.subtle.sign("HMAC", await this.#key(), new TextEncoder().encode(signedValue));
        const credential = `${signedValue}.${encodeBase64Url(new Uint8Array(signature))}`;
        // Issue only a credential that every reader decodes.
        decodeSessionAccessCredential(credential);
        return credential;
    };

    readonly verify = async (credential: string, nowEpochMilliseconds: number): Promise<SessionAccessClaims> => {
        if (!Number.isSafeInteger(nowEpochMilliseconds) || nowEpochMilliseconds < 0) {
            throw new RangeError("The Session credential verification time is invalid");
        }
        const decoded = decodeSessionAccessCredential(credential);
        const valid = await crypto.subtle.verify(
            "HMAC",
            await this.#key(),
            decoded.signature,
            new TextEncoder().encode(decoded.signedValue),
        );
        if (!valid) {
            throw new ProtocolMessageError("The Session credential signature is invalid");
        }
        const { expiresAtEpochMilliseconds, issuedAtEpochMilliseconds } = decoded.claims;
        const lifetimeMilliseconds = expiresAtEpochMilliseconds - issuedAtEpochMilliseconds;
        if (lifetimeMilliseconds <= 0 || lifetimeMilliseconds > MAXIMUM_LIFETIME_MILLISECONDS) {
            throw new ProtocolMessageError("The Session credential lifetime is invalid");
        }
        const issuedAheadMilliseconds = issuedAtEpochMilliseconds - nowEpochMilliseconds;
        // Issuance and verification may run on different Worker clocks.
        if (issuedAheadMilliseconds > MAXIMUM_ISSUANCE_CLOCK_SKEW_MILLISECONDS) {
            throw new ProtocolMessageError(
                `The Session credential was issued ${issuedAheadMilliseconds} milliseconds ahead of the verifier`,
            );
        }
        if (expiresAtEpochMilliseconds <= nowEpochMilliseconds) {
            throw new SessionAccessCredentialExpiredError(nowEpochMilliseconds - expiresAtEpochMilliseconds);
        }
        return decoded.claims;
    };

    readonly #key = async (): Promise<CryptoKey> =>
        await crypto.subtle.importKey("raw", new TextEncoder().encode(this.#secret), HMAC_SHA_256, false, [
            "sign",
            "verify",
        ]);
}
