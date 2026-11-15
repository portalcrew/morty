import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { createStore } from "zustand/vanilla";
import type { Clock } from "../../services/time/clock.ts";
import { formatError } from "../format-error.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";

/** The turn the service reports running, as the Session's execution state holds it. */
export interface RunningTurn {
    readonly commandId: string;
}

type TaskControlFeedback =
    | { readonly kind: "none" }
    | { readonly kind: "failed"; readonly commandId: string; readonly message: string };

/**
 * The stop control. Which turn runs belongs to the Session's execution state; this store keeps what the user asked of
 * it: a stop request for a command, and why the last request failed. Both describe that command only while it runs.
 * The request is the Session's: switching to another pane neither ends it nor forgets it.
 */
export interface SessionTaskControlsStore {
    readonly feedback: TaskControlFeedback;
    /** The command the user last asked to stop; it applies while that command's turn runs. */
    readonly stopRequest: { readonly commandId: string } | null;
    readonly dismissFailure: () => void;
    /** Asks the Computer to stop `running`, the turn the Session's execution state holds running. */
    readonly stop: (running: RunningTurn | null, signal: AbortSignal) => Promise<void>;
}

/** Whether the user's stop request applies to the running turn. */
export function stopRequested(
    tasks: Pick<SessionTaskControlsStore, "stopRequest">,
    running: RunningTurn | null,
): boolean {
    return running !== null && tasks.stopRequest?.commandId === running.commandId;
}

/** The stop control's failure while the targeted turn still runs; another turn, or none, retires it. */
export function stopFailure(
    tasks: Pick<SessionTaskControlsStore, "feedback">,
    running: RunningTurn | null,
): string | null {
    return tasks.feedback.kind === "failed" && tasks.feedback.commandId === running?.commandId
        ? tasks.feedback.message
        : null;
}

export const createSessionTaskControlsStore = (options: {
    readonly clock: Clock;
    readonly sessionTarget: NativeSessionTarget;
    readonly connection: SessionOperationConnection;
}) =>
    createStore<SessionTaskControlsStore>()((set, get) => ({
        feedback: { kind: "none" },
        stopRequest: null,
        dismissFailure: () => set({ feedback: { kind: "none" } }),
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
            set({ feedback: { kind: "none" }, stopRequest: request });
            try {
                await options.connection.send(async (client, requestSignal) => {
                    await client.turns.cancel(options.sessionTarget, running.commandId, requestSignal);
                }, signal);
            } catch (cause) {
                if (signal.aborted && parent.aborted) {
                    throw cause;
                }
                // A request for a later turn replaced this one, whose failure then has nothing left to report. A turn
                // that ended while the request was in flight hides the failure through `stopFailure`.
                if (get().stopRequest !== request) {
                    return;
                }
                set({
                    stopRequest: null,
                    feedback: {
                        kind: "failed",
                        commandId: running.commandId,
                        message: deadline.signal.aborted
                            ? "Stopping has not been confirmed. The agent may still be running. Try Stop again."
                            : formatError(cause, "The agent output could not be stopped."),
                    },
                });
            } finally {
                deadline.abort();
            }
        },
    }));
