import { MortyApiError, MortyError } from "@portalcrew/morty-client";
import { decodeIdentifier, type Identifier, isIdentifier } from "@portalcrew/morty-client/protocol";
import * as v from "valibot";
import type { ApiTransport } from "../api/api-transport.ts";
import type { ApiRequest } from "../api/calls/call.ts";
import { managementCalls } from "../api/calls/management.ts";
import { readJsonBody } from "../api/response-body.ts";

const identifier = v.custom<Identifier>(isIdentifier);
const computerSchema = v.pipe(v.object({ computerId: identifier }), v.readonly());
type ManagedComputer = v.InferOutput<typeof computerSchema>;
const pairingStateSchema = v.object({ computerPairing: v.picklist(["unpaired", "paired", "revoked"]) });

export type ComputerPairing = v.InferOutput<typeof pairingStateSchema>["computerPairing"];

export interface ManagementApiOptions {
    readonly computerId: string;
    readonly fetchRequest: ApiTransport["fetch"];
    readonly getToken: (signal: AbortSignal) => Promise<string | null>;
    readonly origin: string;
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
            throw new MortyApiError("UNAUTHENTICATED", "Your session is unavailable.", 401);
        }
        const response = await this.#fetchRequest({
            ...request,
            signal,
            headers: { authorization: `Bearer ${token}` },
        });
        const value = response.status === 204 ? null : await readJsonBody(response, signal);
        signal.throwIfAborted();
        if (response.status === 401) {
            this.#credentialRejected?.();
        }
        const parsed = v.safeParse(v.object({ error: v.object({ code: v.string(), message: v.string() }) }), value);
        if (!response.ok || value === undefined) {
            // A failure the Worker did not answer, or an answer that is not its JSON, is the service being unavailable.
            throw new MortyApiError(
                !response.ok && parsed.success ? parsed.output.error.code : "service_unavailable",
                !response.ok && parsed.success ? parsed.output.error.message : "Chat management is unavailable.",
                response.status,
                { requestId: response.headers.get("x-morty-request-id") ?? response.headers.get("x-request-id") ?? "" },
            );
        }
        return value;
    };
}

const computerConnectionCodes = new Set(["connection_closed", "computer_offline"]);

export function isComputerConnectionFailure(cause: unknown): boolean {
    return cause instanceof MortyError && computerConnectionCodes.has(cause.code.toLowerCase());
}
