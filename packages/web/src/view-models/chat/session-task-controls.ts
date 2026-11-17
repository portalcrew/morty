import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { Clock } from "../../services/time/clock.ts";
import { formatError } from "../format-error.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";
import type { OperationFailure } from "./session-operation-feedback.ts";

interface RunningTurn {
    readonly commandId: string;
}

/**
 * The stop control. Which turn runs, and whether the Computer is stopping it, belong to the Session's execution state;
 * this store keeps only the stop request this page has sent and not yet heard back about, which the Computer's account
 * may not reflect yet. A failed request reports its failure to the Session's operation feedback. The request is the
 * Session's: switching to another pane neither ends it nor forgets it.
 */
export interface SessionTaskControlsStore {
    readonly stopInFlight: { readonly commandId: string } | null;
    /** Asks the Computer to stop `running`, the turn the Session's execution state holds running. */
    readonly stop: (running: RunningTurn | null, signal: AbortSignal) => Promise<void>;
}

export function stopInFlight(tasks: Pick<SessionTaskControlsStore, "stopInFlight">, commandId: string): boolean {
    return tasks.stopInFlight?.commandId === commandId;
}

export const createSessionTaskControlsStore = (options: {
    readonly clock: Clock;
    readonly sessionTarget: NativeSessionTarget;
    readonly connection: SessionOperationConnection;
    readonly failed: (failure: OperationFailure) => void;
}) =>
    createStore<SessionTaskControlsStore>()((set, get) => ({
        stopInFlight: null,
        stop: async (running, parent) => {
            if (running === null) {
                return;
            }
            const request = { commandId: running.commandId };
            const deadline = new AbortController();
            const signal = AbortSignal.any([parent, deadline.signal]);
            void options.clock.sleep(15_000, signal).then(
                () => deadline.abort(new DOMException("The stop request timed out.", "TimeoutError")),
                () => {},
            );
            const retire = (): boolean => {
                if (get().stopInFlight !== request) {
                    return false;
                }
                set({ stopInFlight: null });
                return true;
            };
            set({ stopInFlight: request });
            try {
                await options.connection.send(async (client, requestSignal) => {
                    await client.turns.cancel(options.sessionTarget, running.commandId, requestSignal);
                }, signal);
                retire();
            } catch (cause) {
                if (signal.aborted && parent.aborted) {
                    throw cause;
                }
                // A request for a later turn replaced this one, whose failure then has nothing left to report.
                if (!retire()) {
                    return;
                }
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
