import { createHash } from "node:crypto";
import { decodeSessionReadyEvent, type SessionReadyEvent } from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { SessionCreationTable } from "../../storage/session/session-creation-table.ts";
import { waitForSharedOperation } from "../../util/wait-for-shared-operation.ts";

/** Durable operation identity survives response loss without inventing a Session identity. */
export class SessionCreations {
    readonly #table: SessionCreationTable;
    readonly #running = new Map<string, { readonly hash: string; readonly result: Promise<SessionReadyEvent> }>();

    constructor(table: SessionCreationTable) {
        this.#table = table;
    }

    readonly settle = async (): Promise<void> => {
        await Promise.allSettled([...this.#running.values()].map(({ result }) => result));
    };

    /** A completed operation can be recovered without revalidating its former execution environment. */
    readonly recover = (
        operationId: string,
        input: unknown,
        signal: AbortSignal,
    ): Promise<SessionReadyEvent> | null => {
        signal.throwIfAborted();
        const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const prior = this.#table.read(operationId);
        const running = this.#running.get(operationId);
        if ((prior !== undefined && prior.requestHash !== hash) || (running !== undefined && running.hash !== hash)) {
            throw new AcpExecutionError("The creation operation has different inputs", {}, "idempotency_conflict");
        }
        if (running !== undefined) {
            return waitForSharedOperation(running.result, signal);
        }
        if (prior !== undefined) {
            return Promise.resolve(decodeSessionReadyEvent(prior.resultJson));
        }
        return null;
    };

    /**
     * Runs a creation once per operation. The receipt is written when the Session is held, so a creation that did not
     * finish has no receipt and a retry creates the Session again: nothing was held, and no client was told of one.
     */
    readonly run = async (
        operationId: string,
        input: unknown,
        signal: AbortSignal,
        create: () => Promise<SessionReadyEvent>,
    ): Promise<SessionReadyEvent> => {
        const recovered = this.recover(operationId, input, signal);
        if (recovered !== null) {
            return await recovered;
        }
        const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const result = Promise.resolve().then(async () => {
            try {
                const ready = await create();
                this.#table.record(operationId, hash, JSON.stringify(ready));
                return ready;
            } finally {
                this.#running.delete(operationId);
            }
        });
        this.#running.set(operationId, { hash, result });
        return await waitForSharedOperation(result, signal);
    };
}
