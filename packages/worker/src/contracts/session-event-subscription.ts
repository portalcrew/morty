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

export type SubscribeSessionEvents = (
    request: SessionEventSubscriptionRequest,
    observer: SessionEventObserver,
) => Promise<void>;
