import type { SessionAccessHolder } from "@morty-build/client/protocol";
import * as v from "valibot";

/** The computer's own credential; its holder chooses a successor by saving it before requesting it. */
export const computerToken = v.pipe(v.string(), v.regex(/^morty_computer_v1_[A-Za-z0-9_-]{43}$/u));

export type Credential = {
    readonly credentialId: string;
} & (
    | { readonly kind: "local" }
    | {
          readonly kind: "browser";
          readonly transferId: string;
          /** The browser device this credential belongs to. */
          readonly deviceId: string;
          /** When this access ends: the device's term, the latest among the links the device opened. */
          readonly accessExpiresAt: number;
      }
);

/**
 * Whose access a credential carries: a browser credential its device's, which outlives the credential's replacement;
 * the local credential its own.
 */
export function accessHolder(credential: Credential): SessionAccessHolder {
    switch (credential.kind) {
        case "browser":
            return { kind: "device", deviceId: credential.deviceId };
        case "local":
            return { kind: "credential", credentialId: credential.credentialId };
    }
}

const linkLifetime = 10 * 60 * 1000;
const hour = 60 * 60 * 1000;

/** How long a device added through a link keeps access, chosen when the link is shared. */
export const deviceAccessDurations = ["1h", "1d", "7d", "30d"] as const;
export type DeviceAccessDuration = (typeof deviceAccessDurations)[number];
const deviceAccessLifetimes: Readonly<Record<DeviceAccessDuration, number>> = {
    "1h": hour,
    "1d": 24 * hour,
    "7d": 7 * 24 * hour,
    "30d": 30 * 24 * hour,
};
export const defaultDeviceAccessDuration: DeviceAccessDuration = "1d";

/** What a shared link grants: until when it can add a device, and until when that device keeps access. */
export interface SharedLinkTerms {
    /** The duration chosen for the device's access, which callers show rather than assume. */
    readonly accessDuration: DeviceAccessDuration;
    readonly expiresAt: number;
    readonly accessExpiresAt: number;
    /** Whether the sharer's own access ends before the chosen duration, and so ends the device's access too. */
    readonly accessLimitedBySharer: boolean;
}

/** Reconstructs the committed terms; retrying never moves either deadline forward. */
export function issuedLinkTerms(
    duration: DeviceAccessDuration,
    record: { readonly createdAt: number; readonly expiresAt: number; readonly accessExpiresAt: number },
): SharedLinkTerms {
    return {
        accessDuration: duration,
        expiresAt: record.expiresAt,
        accessExpiresAt: record.accessExpiresAt,
        accessLimitedBySharer: record.accessExpiresAt < record.createdAt + deviceAccessLifetimes[duration],
    };
}

/**
 * A link adds one device within ten minutes, and that device keeps access for the chosen duration from the link's
 * creation. Neither outlasts the access that shares it, so a device cannot extend its own access by adding another.
 */
export function sharedLinkTerms(sharer: Credential, now: number, duration: DeviceAccessDuration): SharedLinkTerms {
    const limit = sharer.kind === "browser" ? sharer.accessExpiresAt : Number.POSITIVE_INFINITY;
    const chosen = now + deviceAccessLifetimes[duration];
    return {
        accessDuration: duration,
        expiresAt: Math.min(now + linkLifetime, limit),
        accessExpiresAt: Math.min(chosen, limit),
        accessLimitedBySharer: limit < chosen,
    };
}

/**
 * The credential kinds that may perform each identity or management operation; any other operation accepts every
 * active credential. Browser access may use and share the Computer and disconnect the other browsers, so whoever
 * notices a device they did not add can remove it without losing their own access. Only the computer's local
 * credential may pair a Computer, verify the Computer's Agent or revoke all access.
 */
const permittedKinds = {
    shareAccess: ["local", "browser"],
    listDevices: ["local", "browser"],
    pairComputer: ["local"],
    verifyAgent: ["local"],
    revokeAllAccess: ["local"],
    replaceComputer: ["local"],
    endBrowserAccess: ["browser"],
    endOtherBrowserAccess: ["browser"],
    endDeviceAccess: ["local", "browser"],
    retireLocalCredential: ["local"],
} as const satisfies Record<string, readonly Credential["kind"][]>;

export type CredentialOperation = keyof typeof permittedKinds;
export type PermittedCredential<Operation extends CredentialOperation> = Credential & {
    readonly kind: (typeof permittedKinds)[Operation][number];
};
/** Operations only the computer's local credential may perform. */
export type LocalOperation = {
    [Operation in CredentialOperation]: (typeof permittedKinds)[Operation] extends readonly ["local"]
        ? Operation
        : never;
}[CredentialOperation];

export function mayPerform<Operation extends CredentialOperation>(
    credential: Credential,
    operation: Operation,
): credential is PermittedCredential<Operation> {
    const kinds: readonly Credential["kind"][] = permittedKinds[operation];
    return kinds.includes(credential.kind);
}

export const credentialRevocationPaths = {
    local: "/identity/local-credential",
    browser: "/identity/browser-access",
} as const;
