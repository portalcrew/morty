import * as v from "valibot";
import { type CreationOrigin, computerCreationRequest } from "../../contracts/computer-creation.ts";
import { computerObjectName, computerRegionFromId } from "../../contracts/computer-id.ts";
import { ComputerManagementError, relayIdentifier } from "../../contracts/computer-management.ts";
import type { ConfiguredRelayBindings } from "../../contracts/relay-bindings.ts";
import { RequestDeadline } from "../../http/request-deadline.ts";

export class ComputerRelayGateway {
    readonly #bindings: ConfiguredRelayBindings;
    readonly #computerId: string;

    constructor(bindings: ConfiguredRelayBindings, computerId: string) {
        this.#bindings = bindings;
        this.#computerId = v.parse(relayIdentifier, computerId);
        if (computerRegionFromId(this.#computerId) === null) {
            throw new ComputerManagementError("INVALID_ACCOUNT_ID", "The Computer ID is invalid.", 400);
        }
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
            const stub = namespace.getByName(computerObjectName(this.#computerId));
            return await deadline.wait(operation(stub, deadline.signal));
        } catch (cause) {
            signal.throwIfAborted();
            deadline.signal.throwIfAborted();
            throw new ComputerManagementError("RELAY_UNAVAILABLE", "Computer storage is unavailable.", 503, { cause });
        }
    };

    readonly create = (origin: CreationOrigin, signal: AbortSignal): Promise<Response> =>
        this.#call(signal, (stub, signal) => stub.fetch(computerCreationRequest(this.#computerId, origin, signal)));
}
