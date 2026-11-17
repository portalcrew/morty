import type { SessionAccessHolder } from "@portalcrew/morty-client/protocol";

/** The access a browser followed changes under, as authenticated then; the Relay ends the follow when it ends. */
export interface ChangeFollow {
    readonly holder: SessionAccessHolder;
    readonly accessExpiresAt: number | null;
}

/** Authenticates `credential` for following `computerId`'s changes; rejects with the error its reads would answer. */
export type FollowChanges = (
    computerId: string,
    credential: string | undefined,
    signal: AbortSignal,
) => Promise<ChangeFollow>;
