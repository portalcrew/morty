export type MortyTransportPolicy =
    | { readonly kind: "http" }
    | { readonly kind: "websocket"; readonly cancellation: "local" | "remote" };

export interface MortyEndpointCall {
    readonly computerId: string;
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    readonly path: string;
    readonly transport: MortyTransportPolicy;
    readonly timeoutMilliseconds: number;
}

export interface MortyTransportCall {
    readonly endpoint: MortyEndpointCall;
    readonly origin: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | Uint8Array | null;
    readonly signal: AbortSignal;
}
