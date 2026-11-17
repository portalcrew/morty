import type {
    NativeSessionTarget,
    SessionAccessGrant,
    SessionEventsSubscribeCommandRouting,
} from "@portalcrew/morty-client/protocol";

export interface SessionViewerIdentity {
    readonly expiresAt: number;
    readonly grant: SessionAccessGrant;
    readonly sessionFilter: NativeSessionTarget;
    readonly subscriptionId: string;
}

export interface SessionEventObserver {
    readonly message: (data: string) => void;
    readonly close: (code: number, reason: string) => void;
}

export interface SessionViewer extends SessionEventObserver {
    readonly identity: SessionViewerIdentity;
}

interface SessionEventSubscriptionRequest {
    readonly computerId: string;
    readonly harness: string;
    readonly sessionId: string;
    readonly credential: string;
    readonly command: SessionEventsSubscribeCommandRouting;
    readonly signal: AbortSignal;
}

/** Admits a subscription and answers the viewer identity it was opened under. */
export type SubscribeSessionEvents = (
    request: SessionEventSubscriptionRequest,
    observer: SessionEventObserver,
) => Promise<SessionViewerIdentity>;

/**
 * Reopens a viewer the Computer still holds after the Relay woke from hibernation. Its access is checked again by the
 * Relay's periodic viewer checks, as it was before hibernating.
 */
export type RestoreSessionEvents = (
    computerId: string,
    identity: SessionViewerIdentity,
    observer: SessionEventObserver,
    signal: AbortSignal,
) => void;
