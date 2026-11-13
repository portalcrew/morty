import { isIdentifier } from "@morty-build/client/protocol";
import { z } from "zod";

export interface RetiringIdentity {
    readonly kind: "pending";
    readonly computerId: string;
    readonly token: string;
}

type ReplacementState =
    | { readonly kind: "unchanged" }
    | { readonly kind: "unknown" }
    | {
          readonly kind: "revoked";
          readonly previous: RetiringIdentity | { readonly kind: "retired"; readonly computerId: string };
      };

/** The identity that a bootstrap or replacement returned. */
export interface IssuedIdentity {
    readonly computerToken: string;
    readonly computerId: string;
}

/** The user creation secret, saved before requesting a new computer. */
export interface CreatingIdentity {
    readonly kind: "creating";
    readonly creationKey: string;
}

type PairingIntent = { readonly kind: "none" } | { readonly kind: "requesting"; readonly requestKey: string };

/**
 * Revoking all access also replaces the local credential, so a copy of it stops working too. Setup saves the successor
 * before the request: a lost reply then leaves one of the two credentials in force, never neither.
 */
type CredentialRotation = { readonly kind: "none" } | { readonly kind: "requested"; readonly successor: string };

export interface ReadyIdentity extends IssuedIdentity {
    readonly kind: "ready";
    /** Setup owns the unfinished pairing intent; the Worker owns the final Computer binding. */
    readonly pairing: PairingIntent;
    readonly replacement: ReplacementState;
    readonly rotation: CredentialRotation;
}

/**
 * What this computer's setup holds for the one Morty service its state directory belongs to. Only setup's intent is
 * kept here; the Computer owns its pairings and connections in its own state.
 */
export type IdentityState = { readonly kind: "none" } | CreatingIdentity | ReadyIdentity;

/** The saved setup state. The service origin is part of the identity, never a setting that selects another one. */
export interface SavedState {
    readonly base: string;
    readonly identity: CreatingIdentity | ReadyIdentity;
}

/** Version of the saved state's representation; any other representation is refused, never converted. */
const SAVED_STATE_VERSION = 4;

/**
 * The service origin setup accepts: https, or http on a loopback host, with no credentials, path, query or fragment.
 * Null for any other URL; a value that is not a URL throws.
 */
export function serviceOrigin(value: string): string | null {
    const url = new URL(value);
    if (
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
            !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    ) {
        return null;
    }
    return url.origin;
}

// The saved representation, stated once. Decoding accepts exactly it, and encoding is typed by it, so the two cannot
// drift apart. Its keys are the file's, which earlier setups wrote and later ones read.
const savedIdentifier = z.string().refine((value): boolean => isIdentifier(value));
const savedCredential = z.string().regex(/^morty_computer_v1_[A-Za-z0-9_-]{43}$/u);
const savedOrigin = z.string().refine((value) => {
    try {
        return serviceOrigin(value) === value;
    } catch {
        return false;
    }
});

const savedPairing = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("requesting"), requestKey: savedIdentifier }),
]);

const savedReplacement = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unchanged") }),
    z.strictObject({ kind: z.literal("unknown") }),
    z.strictObject({
        kind: z.literal("revoked"),
        previous: z.discriminatedUnion("kind", [
            z.strictObject({
                kind: z.literal("pending"),
                computer_id: savedIdentifier,
                computer_token: savedCredential,
            }),
            z.strictObject({ kind: z.literal("retired"), computer_id: savedIdentifier }),
        ]),
    }),
]);

const savedIdentity = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("creating"), creation_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }),
    z.strictObject({
        kind: z.literal("ready"),
        computer_token: savedCredential,
        computer_id: savedIdentifier,
        pairing: savedPairing,
        replacement: savedReplacement,
        // Present only while a rotation is requested; a state without one keeps its representation.
        credential_rotation: z.strictObject({ successor_token: savedCredential }).optional(),
    }),
]);

const savedState = z.strictObject({
    version: z.literal(SAVED_STATE_VERSION),
    base_url: savedOrigin,
    identity: savedIdentity,
});

type SavedRepresentation = z.infer<typeof savedState>;
type SavedReplacement = z.infer<typeof savedReplacement>;

function encodeReplacement(replacement: ReplacementState): SavedReplacement {
    switch (replacement.kind) {
        case "unchanged":
        case "unknown":
            return { kind: replacement.kind };
        case "revoked":
            return {
                kind: "revoked",
                previous:
                    replacement.previous.kind === "pending"
                        ? {
                              kind: "pending",
                              computer_id: replacement.previous.computerId,
                              computer_token: replacement.previous.token,
                          }
                        : { kind: "retired", computer_id: replacement.previous.computerId },
            };
        default: {
            const exhaustive: never = replacement;
            return exhaustive;
        }
    }
}

function decodeReplacement(saved: SavedReplacement): ReplacementState {
    switch (saved.kind) {
        case "unchanged":
        case "unknown":
            return { kind: saved.kind };
        case "revoked":
            return {
                kind: "revoked",
                previous:
                    saved.previous.kind === "pending"
                        ? {
                              kind: "pending",
                              computerId: saved.previous.computer_id,
                              token: saved.previous.computer_token,
                          }
                        : { kind: "retired", computerId: saved.previous.computer_id },
            };
        default:
            return saved satisfies never;
    }
}

export function encodeSavedState(state: SavedState): SavedRepresentation {
    const identity = state.identity;
    switch (identity.kind) {
        case "creating":
            return {
                version: SAVED_STATE_VERSION,
                base_url: state.base,
                identity: { kind: "creating", creation_key: identity.creationKey },
            };
        case "ready":
            return {
                version: SAVED_STATE_VERSION,
                base_url: state.base,
                identity: {
                    kind: "ready",
                    computer_token: identity.computerToken,
                    computer_id: identity.computerId,
                    pairing: identity.pairing,
                    replacement: encodeReplacement(identity.replacement),
                    ...(identity.rotation.kind === "requested"
                        ? { credential_rotation: { successor_token: identity.rotation.successor } }
                        : {}),
                },
            };
        default: {
            const exhaustive: never = identity;
            return exhaustive;
        }
    }
}

/** The saved state `value` holds, or null when it is not exactly the representation setup writes. */
export function decodeSavedState(value: unknown): SavedState | null {
    const decoded = savedState.safeParse(value);
    if (!decoded.success) {
        return null;
    }
    const saved = decoded.data;
    const base = saved.base_url;
    switch (saved.identity.kind) {
        case "creating":
            return { base, identity: { kind: "creating", creationKey: saved.identity.creation_key } };
        case "ready": {
            const ready = saved.identity;
            return {
                base,
                identity: {
                    kind: "ready",
                    computerToken: ready.computer_token,
                    computerId: ready.computer_id,
                    pairing: ready.pairing,
                    replacement: decodeReplacement(ready.replacement),
                    rotation:
                        ready.credential_rotation === undefined
                            ? { kind: "none" }
                            : { kind: "requested", successor: ready.credential_rotation.successor_token },
                },
            };
        }
        default:
            return saved.identity satisfies never;
    }
}
