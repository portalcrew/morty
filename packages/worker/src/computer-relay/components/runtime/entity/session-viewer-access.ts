import type { SessionViewerIdentity } from "../../../../contracts/session-event-subscription.ts";

/** Whether a held Session viewer may keep receiving its Session's events, or how it closes once it may not. */
export type SessionViewerAccess =
    | { readonly kind: "held" }
    | { readonly kind: "ended"; readonly code: 1000 | 1008; readonly reason: string };

/**
 * A viewer's access holds while its credential's term has not passed and the Computer's identities still honor the
 * credential's grant. Admission and the periodic check read the grant and close a viewer whose grant ended, so a
 * viewer that is still held had its grant honored at the last read, and delivery in between passes `"granted"`.
 */
export function sessionViewerAccess(
    identity: Pick<SessionViewerIdentity, "expiresAt">,
    now: number,
    grant: "granted" | "revoked",
): SessionViewerAccess {
    if (identity.expiresAt <= now) {
        return { kind: "ended", code: 1000, reason: "Session access expired" };
    }
    if (grant === "revoked") {
        return { kind: "ended", code: 1008, reason: "Session access revoked" };
    }
    return { kind: "held" };
}
