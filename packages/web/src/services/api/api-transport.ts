import type { WsTransport } from "@portalcrew/morty-client";
import type { ApiCall } from "./calls/call.ts";

export interface ApiResponseSnapshot {
    readonly status: number;
    readonly headers: Headers;
    readonly body: string;
}

export interface ApiTransport {
    /** Application-owned; callers release their requests/subscriptions, never this connection. */
    readonly computerTransport: (computerId: string) => WsTransport;
    /** The page is in front again: every Computer connection checks now that it still gets through. */
    readonly verifyConnections: () => void;
    readonly fetch: (call: ApiCall) => Promise<Response>;
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
    readonly waitForChange: (call: ApiCall, onReady?: (snapshot: ApiResponseSnapshot) => void) => Promise<void>;
    readonly dispose: () => void;
}
