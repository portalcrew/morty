import type { PayloadDecryptor, PayloadEncryptor } from "../encryption.ts";

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

export interface MortyMessageCodec {
    readonly kind: string;
    readonly encode: (value: unknown, encryption: PayloadEncryptor, signal: AbortSignal) => Promise<string>;
    readonly decode: (encoded: string, encryption: PayloadDecryptor, signal: AbortSignal) => Promise<unknown>;
}

export interface MortyEndpointCall extends MortyTransportEndpoint {
    readonly encrypted: {
        readonly request: readonly MortyMessageCodec[];
        readonly response: readonly MortyMessageCodec[];
    };
}

export interface MortyTransportCall {
    readonly endpoint: MortyTransportEndpoint;
    readonly origin: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | Uint8Array | null;
    readonly signal: AbortSignal;
}
