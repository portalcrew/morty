import { decodeIdentifier, type Identifier, isIdentifier } from "@morty-build/client/protocol";
import * as v from "valibot";
import type { ApiTransport } from "../api/api-transport.ts";
import type { ApiRequest } from "../api/calls/call.ts";
import { managementCalls } from "../api/calls/management.ts";

const identifier = v.custom<Identifier>(isIdentifier);
const computerSchema = v.pipe(v.object({ computerId: identifier }), v.readonly());
type ManagedComputer = v.InferOutput<typeof computerSchema>;
const pairingStateSchema = v.object({ computerPairing: v.picklist(["unpaired", "paired", "revoked"]) });

/**
 * Where the Computer's Runtime pairing stands: not yet paired (or its pairing request is pending or expired), paired,
 * or revoked until setup pairs it again. The Relay owns this fact; the Worker reads it for the Computer.
 */
export type ComputerPairing = v.InferOutput<typeof pairingStateSchema>["computerPairing"];

export interface ManagementApiOptions {
    readonly computerId: string;
    readonly fetchRequest: ApiTransport["fetch"];
    readonly getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly origin: string;
    /** Told when the Worker refuses the access as unauthenticated; whoever owns that access decides what it means. */
    readonly credentialRejected?: () => void;
}

export class ManagementApi {
    readonly #fetchRequest: ApiTransport["fetch"];
    readonly #getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly #origin: string;
    readonly #computerId: Identifier;
    readonly #credentialRejected: (() => void) | undefined;
    constructor(options: ManagementApiOptions) {
        this.#fetchRequest = options.fetchRequest;
        this.#getToken = options.getToken;
        this.#origin = options.origin;
        this.#computerId = decodeIdentifier(options.computerId);
        this.#credentialRejected = options.credentialRejected;
    }

    readonly readComputer = async (signal: AbortSignal): Promise<ManagedComputer | null> =>
        v.parse(
            v.object({ computer: v.nullable(computerSchema) }),
            await this.#request(
                managementCalls.readComputer({ origin: this.#origin, computerId: this.#computerId }),
                signal,
            ),
        ).computer;

    readonly readComputerPairing = async (signal: AbortSignal): Promise<ComputerPairing> =>
        v.parse(
            pairingStateSchema,
            await this.#request(
                managementCalls.readComputerPairing({ origin: this.#origin, computerId: this.#computerId }),
                signal,
            ),
        ).computerPairing;

    readonly #request = async (request: ApiRequest, requestSignal: AbortSignal): Promise<unknown> => {
        const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(request.endpoint.timeoutMilliseconds)]);
        const token = await this.#getToken(signal);
        if (token === null) {
            throw new CloudApiError("UNAUTHENTICATED", "Your session is unavailable.");
        }
        const response = await this.#fetchRequest({
            ...request,
            signal,
            headers: { authorization: `Bearer ${token}` },
        });
        const value: unknown = response.status === 204 ? null : await response.json();
        signal.throwIfAborted();
        if (response.status === 401) {
            this.#credentialRejected?.();
        }
        if (!response.ok) {
            const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
            throw new CloudApiError(
                parsed.success ? parsed.output.error.code : "MANAGEMENT_UNAVAILABLE",
                parsed.success ? parsed.output.error.message : "Chat management is unavailable.",
                response.status,
                response.headers.get("x-morty-request-id") ?? response.headers.get("x-request-id") ?? "",
            );
        }
        return value;
    };
}

export class CloudApiError extends Error {
    readonly code: string;
    readonly status: number | null;
    readonly requestId: string;
    constructor(code: string, message: string, status: number | null = null, requestId = "") {
        super(message);
        this.code = code;
        this.status = status;
        this.requestId = requestId;
        this.name = "CloudApiError";
    }
}

const computerConnectionCodes = new Set(["connection_closed", "computer_offline"]);

export function isComputerConnectionFailure(cause: unknown): boolean {
    return cause instanceof CloudApiError && computerConnectionCodes.has(cause.code.toLowerCase());
}
