import type {
    NativeSessionTarget,
    SessionAccessGrant,
    SessionEventsSubscribeCommandRouting,
} from "@morty-build/client/protocol";

export interface SessionViewerIdentity {
    readonly role: "viewer";
    readonly expiresAt: number;
    readonly credential: {
        readonly signingKeyId: string;
        readonly grant: SessionAccessGrant;
    };
    readonly computerId: string;
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

/** A browser's request to follow one Session's live events, as its frame named the Session and the credential. */
interface SessionEventSubscriptionRequest {
    /** The Computer the frame's path names; the subscriber checks that it owns it. */
    readonly computerId: string;
    readonly harness: string;
    readonly sessionId: string;
    /** The bearer credential of the frame's `authorization` header. */
    readonly credential: string;
    readonly command: SessionEventsSubscribeCommandRouting;
    /** The caller owns cancellation for the entire subscription, including admission. */
    readonly signal: AbortSignal;
}

export type SubscribeSessionEvents = (
    request: SessionEventSubscriptionRequest,
    observer: SessionEventObserver,
) => Promise<void>;
