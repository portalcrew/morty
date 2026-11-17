export type MortyTransportPolicy =
    | { readonly kind: "http" }
    | { readonly kind: "websocket"; readonly cancellation: "local" | "remote" };

export interface MortyTransportEndpoint {
    readonly computerId: string;
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    readonly path: string;
    readonly transport: MortyTransportPolicy;
    readonly timeoutMilliseconds: number;
}

export interface MortyOperationEndpoint extends MortyTransportEndpoint {
    readonly operation: string;
}

export interface MortyTransportCall {
    readonly endpoint: MortyTransportEndpoint;
    readonly origin: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | Uint8Array | null;
    readonly signal: AbortSignal;
}

/** One attempt of a request. Its ID names the attempt on the wire, so the client and the Relay record one identity. */
export interface MortyTransportRequest extends MortyTransportCall {
    readonly requestId: string;
}
