import type { MortyTransportPolicy } from "@morty-build/client";

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
    readonly watch: "snapshot" | "none";
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
