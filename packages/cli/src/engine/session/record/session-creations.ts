import { createHash } from "node:crypto";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { SessionCreationTable } from "../../storage/session/session-creation-table.ts";
import { waitForSharedOperation } from "../../util/wait-for-shared-operation.ts";

/**
 * Durable operation identity survives response loss without inventing a Session identity. An operation's receipt
 * records only which Session it created; a retry answers that Session as it stands now, so it never repeats settings,
 * capabilities or a title that changed since.
 */
export class SessionCreations {
    readonly #table: SessionCreationTable;
    readonly #running = new Map<string, { readonly hash: string; readonly target: Promise<NativeSessionTarget> }>();

    constructor(table: SessionCreationTable) {
        this.#table = table;
    }

    readonly settle = async (): Promise<void> => {
        await Promise.allSettled([...this.#running.values()].map(({ target }) => target));
    };

    /**
     * The Session an earlier or running creation of this operation created, or null when none did. The same operation
     * with different inputs is refused.
     */
    readonly created = (
        operationId: string,
        input: unknown,
        signal: AbortSignal,
    ): Promise<NativeSessionTarget> | null => {
        signal.throwIfAborted();
        const hash = requestHash(input);
        const prior = this.#table.read(operationId);
        const running = this.#running.get(operationId);
        if ((prior !== undefined && prior.requestHash !== hash) || (running !== undefined && running.hash !== hash)) {
            throw new AcpExecutionError("The creation operation has different inputs", {}, "idempotency_conflict");
        }
        if (running !== undefined) {
            return waitForSharedOperation(running.target, signal);
        }
        return prior === undefined ? null : Promise.resolve(prior.target);
    };

    /**
     * Runs a creation once per operation and answers it. The receipt is written when the Session is held, so a creation
     * that did not finish has no receipt and a retry creates the Session again: nothing was held, and no client was
     * told of one. An operation that already created its Session is answered by `current` instead.
     */
    readonly run = async <Answer extends { readonly target: NativeSessionTarget }>(
        operationId: string,
        input: unknown,
        signal: AbortSignal,
        create: () => Promise<Answer>,
        current: (target: NativeSessionTarget) => Promise<Answer>,
    ): Promise<Answer> => {
        const created = this.created(operationId, input, signal);
        if (created !== null) {
            return await current(await created);
        }
        const hash = requestHash(input);
        const answer = Promise.resolve().then(async () => {
            try {
                const result = await create();
                this.#table.record(operationId, hash, result.target);
                return result;
            } finally {
                this.#running.delete(operationId);
            }
        });
        const target = answer.then((result) => result.target);
        // A borrower that waits observes a failed creation; nobody else must.
        target.catch(() => undefined);
        this.#running.set(operationId, { hash, target });
        return await waitForSharedOperation(answer, signal);
    };
}

function requestHash(input: unknown): string {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
