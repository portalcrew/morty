import type { SessionAccessHolder } from "@portalcrew/morty-client/protocol";

/**
 * The access a browser follows changes under, with the end of its term as last read; the Relay ends the follow when
 * the access ends.
 */
export interface ChangeFollow {
    readonly holder: SessionAccessHolder;
    readonly accessExpiresAt: number | null;
}

/** Whether an access still holds, and the end of its current term; a null term holds until it is revoked. */
export type AccessStanding = { readonly kind: "ended" } | { readonly kind: "held"; readonly until: number | null };

/** Authenticates `credential` for following `computerId`'s changes; rejects with the error its reads would answer. */
export type FollowChanges = (
    computerId: string,
    credential: string | undefined,
    signal: AbortSignal,
) => Promise<ChangeFollow>;
