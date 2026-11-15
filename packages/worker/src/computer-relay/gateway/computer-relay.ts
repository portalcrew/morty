import * as v from "valibot";
import { type CreationOrigin, computerCreationRequest } from "../../contracts/computer-creation.ts";
import { computerObjectName, decodeComputerPlacement } from "../../contracts/computer-id.ts";
import type { ComputerLocationHint } from "../../contracts/computer-location.ts";
import { ComputerManagementError, relayIdentifier } from "../../contracts/computer-management.ts";
import type { ConfiguredRelayBindings } from "../../contracts/relay-bindings.ts";
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
    ): Promise<Value> => {
        // Creating a computer opens and migrates its storage, the slowest call into it.
        using deadline = new RequestDeadline(signal, 45_000);
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

    /** Creates this computer, or answers the replacement an earlier request with the same origin created. */
    readonly create = (origin: CreationOrigin, signal: AbortSignal): Promise<Response> =>
        this.#call(signal, (stub, signal) => stub.fetch(computerCreationRequest(this.#computerId, origin, signal)));
}
