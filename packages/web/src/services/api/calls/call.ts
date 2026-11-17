import type { MortyTransportPolicy } from "@portalcrew/morty-client";
import type { RelayChangeTopic } from "@portalcrew/morty-client/protocol";

export interface ComputerCallTarget {
    readonly origin: string;
    readonly computerId: string;
}

export interface WorkerCallTarget {
    readonly origin: string;
    readonly computerId: null;
}

export type ApiEndpoint = {
    readonly url: URL;
    readonly method: "GET" | "POST" | "DELETE";
    readonly operation: string;
    /** A watched resource is read again when the Relay tells that its topic changed. */
    readonly watch: "none" | { readonly kind: "changes"; readonly topic: RelayChangeTopic };
    readonly timeoutMilliseconds: number;
} & (
    | {
          readonly target: { readonly kind: "worker"; readonly computerId: null };
          readonly transport: { readonly kind: "http" };
      }
    | {
          readonly target: { readonly kind: "computer"; readonly computerId: string };
          readonly transport: MortyTransportPolicy;
      }
);

export interface ApiRequest {
    readonly endpoint: ApiEndpoint;
    readonly body?: string | null;
}

export interface ApiCall extends ApiRequest {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly redirect?: RequestRedirect;
}
