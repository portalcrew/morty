import { createStore } from "zustand/vanilla";
import type { QueuedCommand } from "./session-execution.ts";

/** Why an operation the user asked of the Session failed, with what the failure describes while it still applies. */
export type OperationFailure =
    | { readonly operation: "rename" | "settings" | "older-history" | "delete-queued"; readonly message: string }
    /** A failed stop describes its turn while that turn runs. */
    | { readonly operation: "stop"; readonly commandId: string; readonly message: string }
    /** A failed steer describes its message while the Computer still queues it. */
    | { readonly operation: "steer"; readonly commandId: string; readonly message: string };

/**
 * The failure the composer reports for the Session: that of the last operation that failed. A newer failure replaces
 * it, and it ends when the user asks something of the Session again, so the composer never reports an older failure
 * over a newer one. Operations report their failures here and keep none of their own.
 */
export interface SessionOperationFeedbackStore {
    readonly failure: OperationFailure | null;
    readonly failed: (failure: OperationFailure) => void;
    /** The user asked something of the Session again, so the last failure no longer describes what they see. */
    readonly dismiss: () => void;
    /** `operation` began again on its own, so its own earlier failure no longer applies. */
    readonly retried: (operation: OperationFailure["operation"]) => void;
}

export const createSessionOperationFeedbackStore = () =>
    createStore<SessionOperationFeedbackStore>()((set, get) => ({
        failure: null,
        failed: (failure) => set({ failure }),
        dismiss: () => set({ failure: null }),
        retried: (operation) => {
            if (get().failure?.operation === operation) {
                set({ failure: null });
            }
        },
    }));

/** What the composer reports of the last failure, while that failure still describes the Session. */
export function operationFailureMessage(
    failure: OperationFailure | null,
    running: { readonly commandId: string } | null,
    queued: readonly QueuedCommand[],
): string | null {
    if (failure === null) {
        return null;
    }
    switch (failure.operation) {
        case "stop":
            return failure.commandId === running?.commandId ? failure.message : null;
        case "steer":
            return queued.some((message) => message.commandId === failure.commandId) ? failure.message : null;
        case "rename":
        case "settings":
        case "older-history":
        case "delete-queued":
            return failure.message;
        default:
            return failure satisfies never;
    }
}
