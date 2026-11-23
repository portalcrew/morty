import type { NativeSessionLocation } from "@portalcrew/morty-client";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import { formatError } from "../format-error.ts";
import { type ForkIntent, forkIntent } from "./native-session-fork.ts";
import type { OperationFailure } from "./session-operation-feedback.ts";

type SessionFork =
    | { readonly kind: "idle"; readonly retained: ForkIntent | null }
    | { readonly kind: "forking"; readonly intent: ForkIntent };

export type SessionForkStore = {
    readonly fork: SessionFork;
    readonly start: (location: NativeSessionLocation, signal: AbortSignal) => Promise<void>;
};

/**
 * A fork whose answer was lost keeps its identity for the next attempt; a fork that completed ends it, so forking again
 * creates another Session.
 */
export function createSessionForkStore(options: {
    readonly request: (
        operationId: string,
        location: NativeSessionLocation,
        signal: AbortSignal,
    ) => Promise<{ readonly target: NativeSessionTarget }>;
    readonly forked: (target: NativeSessionTarget) => void;
    readonly failed: (failure: OperationFailure) => void;
}) {
    return createStore<SessionForkStore>()((set, get) => ({
        fork: { kind: "idle", retained: null },
        start: async (location, signal) => {
            signal.throwIfAborted();
            const current = get().fork;
            if (current.kind === "forking") {
                return;
            }
            const intent = forkIntent(current.retained, location, () => crypto.randomUUID());
            set({ fork: { kind: "forking", intent } });
            let target: NativeSessionTarget;
            try {
                ({ target } = await options.request(intent.operationId, location, signal));
                signal.throwIfAborted();
            } catch (cause) {
                set({ fork: { kind: "idle", retained: intent } });
                signal.throwIfAborted();
                options.failed({ operation: "fork", message: formatError(cause, "The session could not be forked.") });
                return;
            }
            set({ fork: { kind: "idle", retained: null } });
            options.forked(target);
        },
    }));
}
