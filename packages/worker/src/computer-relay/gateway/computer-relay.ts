import * as v from "valibot";
import type { AccountProvisioner } from "../../contracts/account-provisioning.ts";
import type { CloudBindings } from "../../contracts/cloud-bindings.ts";
import { accountComputerId, computerObjectName, decodeComputerPlacement } from "../../contracts/computer-id.ts";
import type { ComputerLocationHint } from "../../contracts/computer-location.ts";
import {
    ComputerManagementError,
    computerManagementSchema,
    relayIdentifier,
} from "../../contracts/computer-management.ts";
import { computerAccountPath } from "../../contracts/computer-relay-http.ts";
import { validateIdentifier } from "../../contracts/relay/pairing.ts";
import { type ConfiguredRelayBindings, relayBindings } from "../../contracts/relay-bindings.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";
import { DatabaseError } from "../../infra/sql-database.ts";

/** Calls from outside a computer enter it only through its Durable Object HTTP endpoint. */
export class ComputerRelayGateway {
    readonly #bindings: ConfiguredRelayBindings;
    readonly #computerId: string;
    readonly #locationHint: ComputerLocationHint;

    constructor(bindings: ConfiguredRelayBindings, computerId: string) {
        this.#bindings = bindings;
        this.#computerId = v.parse(relayIdentifier, computerId);
        const placement = decodeComputerPlacement(this.#computerId);
        if (placement === null) {
            throw new ComputerManagementError("INVALID_ACCOUNT_ID", "The Computer ID is invalid.", 400);
        }
        this.#locationHint = placement.locationHint;
    }

    readonly #call = async <Value>(
        signal: AbortSignal,
        operation: (stub: DurableObjectStub, signal: AbortSignal) => Promise<Value>,
        milliseconds = 15_000,
    ): Promise<Value> => {
        using deadline = new RequestDeadline(signal, milliseconds);
        try {
            deadline.signal.throwIfAborted();
            const namespace = this.#bindings.COMPUTER_RELAY;
            const stub = namespace.getByName(computerObjectName(this.#computerId), {
                locationHint: this.#locationHint,
            });
            return await deadline.wait(operation(stub, deadline.signal));
        } catch (cause) {
            signal.throwIfAborted();
            throw new DatabaseError(
                deadline.signal.aborted ? "database_timeout" : "database_unavailable",
                "Computer storage is unavailable",
                { cause },
            );
        }
    };

    /** Creates the computer's account, or confirms the one an earlier request created. */
    readonly createComputerAccount = (signal: AbortSignal) =>
        this.#call(signal, async (stub, signal) => {
            const response = await stub.fetch(
                new Request(new URL(computerAccountPath(this.#computerId), "https://computer-relay.internal"), {
                    method: "POST",
                    signal,
                }),
            );
            if (response.status !== 200) {
                await response.body?.cancel();
                throw new DatabaseError("database_unavailable", "Computer account is unavailable");
            }
            const body: unknown = await response.json();
            return v.parse(computerManagementSchema, body);
        });

    readonly bootstrap = (request: Request): Promise<Response> =>
        this.#call(request.signal, (stub, signal) => stub.fetch(new Request(request, { signal })), 45_000);
}

/** Creates the computer an account reference names, or returns the one an earlier request created. */
export function accountProvisioner(bindings: CloudBindings): AccountProvisioner {
    return async (reference, location, signal) => {
        const computerId = await accountComputerId(validateIdentifier(reference, "client_reference"), location);
        signal.throwIfAborted();
        return await new ComputerRelayGateway(relayBindings(bindings), computerId).createComputerAccount(signal);
    };
}
