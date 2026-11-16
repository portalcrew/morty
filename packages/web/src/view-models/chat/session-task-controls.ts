import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { Clock } from "../../services/time/clock.ts";
import { formatError } from "../format-error.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";
import type { OperationFailure } from "./session-operation-feedback.ts";

export interface RunningTurn {
    readonly commandId: string;
}

/**
 * The stop control. Which turn runs belongs to the Session's execution state; this store keeps what the user asked of
 * it: a stop request for a command, which applies only while that command runs. A failed request reports its failure to
 * the Session's operation feedback. The request is the Session's: switching to another pane neither ends it nor forgets
 * it.
 */
export interface SessionTaskControlsStore {
    /** The command the user last asked to stop; it applies while that command's turn runs. */
    readonly stopRequest: { readonly commandId: string } | null;
    /** Asks the Computer to stop `running`, the turn the Session's execution state holds running. */
    readonly stop: (running: RunningTurn | null, signal: AbortSignal) => Promise<void>;
}

export function stopRequested(
    tasks: Pick<SessionTaskControlsStore, "stopRequest">,
    running: RunningTurn | null,
): boolean {
    return running !== null && tasks.stopRequest?.commandId === running.commandId;
}

export const createSessionTaskControlsStore = (options: {
    readonly clock: Clock;
    readonly sessionTarget: NativeSessionTarget;
    readonly connection: SessionOperationConnection;
    readonly failed: (failure: OperationFailure) => void;
}) =>
    createStore<SessionTaskControlsStore>()((set, get) => ({
        stopRequest: null,
        stop: async (running, parent) => {
            if (running === null || stopRequested(get(), running)) {
                return;
            }
            const request = { commandId: running.commandId };
            const deadline = new AbortController();
            const signal = AbortSignal.any([parent, deadline.signal]);
            void options.clock.sleep(15_000, signal).then(
                () => deadline.abort(new DOMException("The stop request timed out.", "TimeoutError")),
                () => {},
            );
            set({ stopRequest: request });
            try {
                await options.connection.send(async (client, requestSignal) => {
                    await client.turns.cancel(options.sessionTarget, running.commandId, requestSignal);
                }, signal);
            } catch (cause) {
                if (signal.aborted && parent.aborted) {
                    throw cause;
                }
                // A request for a later turn replaced this one, whose failure then has nothing left to report. A turn
                // that ended while the request was in flight retires the failure, which describes only its turn.
                if (get().stopRequest !== request) {
                    return;
                }
                set({ stopRequest: null });
                options.failed({
                    operation: "stop",
                    commandId: running.commandId,
                    message: deadline.signal.aborted
                        ? "Stopping has not been confirmed. The agent may still be running. Try Stop again."
                        : formatError(cause, "The agent output could not be stopped."),
                });
            } finally {
                deadline.abort();
            }
        },
    }));
