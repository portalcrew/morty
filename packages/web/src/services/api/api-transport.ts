import type { WsTransport } from "@morty-build/client";
import type { ApiCall } from "./calls/call.ts";

export interface ApiResponseSnapshot {
    readonly status: number;
    readonly headers: Headers;
    readonly body: string;
}

export interface ApiTransport {
    /** Application-owned; callers release their requests/subscriptions, never this connection. */
    readonly computerTransport: (computerId: string) => WsTransport;
    readonly fetch: (call: ApiCall) => Promise<Response>;
    readonly measureMortyLatency: (signal: AbortSignal) => Promise<number>;
    readonly waitForChange: (call: ApiCall, onReady?: (snapshot: ApiResponseSnapshot) => void) => Promise<void>;
    readonly dispose: () => void;
}
