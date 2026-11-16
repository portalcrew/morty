import { createHash } from "node:crypto";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import { type SharedOperation, shareOperation } from "../../util/shared-operation.ts";
import { waitForSharedOperation } from "../../util/wait-for-shared-operation.ts";
import type { SessionCreationIdentity, SessionStore } from "./session-store.ts";

interface RunningCreation {
    readonly hash: string;
    readonly creation: SharedOperation<{ readonly target: NativeSessionTarget }>;
}

/**
 * Durable operation identity survives response loss without inventing a Session identity. An operation's receipt
 * records only which Session it created; a retry answers that Session as it stands now, so it never repeats settings,
 * capabilities or a title that changed since. A running creation belongs to every request of its operation: one
 * request leaving, such as a retry's earlier attempt whose connection closed, never cancels it for the others.
 */
export class SessionCreations {
    readonly #store: Pick<SessionStore, "creation">;
    readonly #running = new Map<string, RunningCreation>();

    constructor(store: Pick<SessionStore, "creation">) {
        this.#store = store;
    }

    readonly settle = async (): Promise<void> => {
        await Promise.all([...this.#running.values()].map(({ creation }) => creation.ended));
    };

    /**
     * The Session an earlier or running creation of this operation created, or null when none did. The same operation
     * with different inputs is refused. A creation every request left is ending; it is waited out, and then only its
     * receipt answers.
     */
    readonly created = async (
        operationId: string,
        input: unknown,
        signal: AbortSignal,
    ): Promise<NativeSessionTarget | null> => {
        signal.throwIfAborted();
        const hash = requestHash(input);
        const prior = this.#store.creation(operationId);
        const running = this.#running.get(operationId);
        if ((prior !== undefined && prior.requestHash !== hash) || (running !== undefined && running.hash !== hash)) {
            throw new AcpExecutionError("The creation operation has different inputs", {}, "idempotency_conflict");
        }
        if (running === undefined) {
            return prior?.target ?? null;
        }
        if (running.creation.abandoned()) {
            await waitForSharedOperation(running.creation.ended, signal);
            return await this.created(operationId, input, signal);
        }
        return (await running.creation.wait(signal)).target;
    };

    /**
     * Runs a creation once per operation and answers it. `create` holds the Session with the identity it is given, and
     * the store writes the receipt in that same write, so a creation that did not finish has no receipt and a retry
     * creates the Session again: nothing was held, and no client was told of one. An operation that already created
     * its Session is answered by `current` instead. `create` runs under the creation's own signal, which ends only
     * when every request of the operation has left.
     */
    readonly run = async <Answer extends { readonly target: NativeSessionTarget }>(
        operationId: string,
        input: unknown,
        signal: AbortSignal,
        create: (signal: AbortSignal, creation: SessionCreationIdentity) => Promise<Answer>,
        current: (target: NativeSessionTarget) => Promise<Answer>,
    ): Promise<Answer> => {
        const created = await this.created(operationId, input, signal);
        if (created !== null) {
            return await current(created);
        }
        if (this.#running.has(operationId) || this.#store.creation(operationId) !== undefined) {
            // Another request of the operation started or finished its creation while this one waited.
            return await this.run(operationId, input, signal, create, current);
        }
        const hash = requestHash(input);
        const { operation, first } = shareOperation(async (shared) => {
            try {
                return await create(shared, { operationId, requestHash: hash });
            } finally {
                this.#running.delete(operationId);
            }
        }, signal);
        this.#running.set(operationId, { hash, creation: operation });
        return await first;
    };
}

function requestHash(input: unknown): string {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
