import { MortyValidationError } from "@morty-build/client";
import { isIdentifier } from "@morty-build/client/protocol";
import type { ApiEndpoint, ApiRequest, ComputerCallTarget, WorkerCallTarget } from "./call.ts";

export interface CallDefinition {
    readonly method: ApiEndpoint["method"];
    readonly operation: string;
    readonly watch: ApiEndpoint["watch"];
    readonly timeoutMilliseconds: number;
    readonly transport: ApiEndpoint["transport"];
}

export interface ComputerCallEncoding extends ComputerCallTarget {
    /** The resource under the Computer; empty for the Computer itself. */
    readonly path: string;
    readonly definition: CallDefinition;
    readonly body?: unknown;
}

export function encodeComputerCall({ origin, computerId, path, definition, body }: ComputerCallEncoding): ApiRequest {
    if (!isIdentifier(computerId)) {
        throw new MortyValidationError("The Computer identifier is invalid");
    }
    return {
        endpoint: {
            ...definition,
            target: { kind: "computer", computerId },
            url: new URL(
                `/morty/api/v1/computers/${encodeURIComponent(computerId)}${path === "" ? "" : `/${path}`}`,
                origin,
            ),
        },
        body: body === undefined ? null : JSON.stringify(body),
    };
}

export function encodeWorkerCall({
    origin,
    computerId,
    path,
    definition,
    body,
}: WorkerCallTarget & {
    readonly path: string;
    readonly definition: CallDefinition & { readonly transport: { readonly kind: "http" } };
    readonly body?: unknown;
}): ApiRequest {
    if (computerId !== null) {
        throw new MortyValidationError("A Worker call must not target a Computer");
    }
    return {
        endpoint: {
            ...definition,
            target: { kind: "worker", computerId },
            url: new URL(`/morty/api/v1/${path}`, origin),
        },
        body: body === undefined ? null : JSON.stringify(body),
    };
}
