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

/** The caller owns cancellation for the entire subscription, including admission. */
export type SubscribeSessionEvents = (
    request: Request,
    subscription: SessionEventsSubscribeCommandRouting,
    observer: SessionEventObserver,
) => Promise<void>;
