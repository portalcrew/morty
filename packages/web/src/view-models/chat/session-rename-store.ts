import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import { isSessionClosedFailure } from "../format-error.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";
import type { OperationFailure } from "./session-operation-feedback.ts";

/** The Session owns one explicit rename through its acknowledgement and authoritative refresh. */
export type SessionRename =
    | { readonly kind: "none" }
    | { readonly kind: "waiting"; readonly title: string }
    | { readonly kind: "sending"; readonly title: string }
    | { readonly kind: "refreshing"; readonly title: string };

export type SessionRenameStore = {
    readonly rename: SessionRename;
    readonly confirm: (title: string, signal: AbortSignal) => Promise<void>;
};

/**
 * Switching panes neither cancels nor resends a rename. A failure reports to the Session's operation feedback, and an
 * ambiguous one requires a new user decision.
 */
export function createSessionRenameStore(options: {
    readonly sessionTarget: NativeSessionTarget;
    readonly connection: SessionOperationConnection;
    readonly refreshTitle: (signal: AbortSignal) => Promise<void>;
    readonly failed: (failure: OperationFailure) => void;
}) {
    return createStore<SessionRenameStore>()((set, get) => ({
        rename: { kind: "none" },
        confirm: async (title, signal) => {
            signal.throwIfAborted();
            const current = get().rename;
            switch (current.kind) {
                case "waiting":
                case "sending":
                case "refreshing":
                    return;
                case "none":
                    break;
                default:
                    return current satisfies never;
            }
            set({ rename: { kind: "waiting", title } });
            const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
            try {
                await options.connection.send(async (client, sendingSignal) => {
                    sendingSignal.throwIfAborted();
                    set({ rename: { kind: "sending", title } });
                    await client.sessions.rename(options.sessionTarget, title, sendingSignal);
                }, requestSignal);
                requestSignal.throwIfAborted();
                set({ rename: { kind: "refreshing", title } });
                await options.refreshTitle(requestSignal);
                requestSignal.throwIfAborted();
                set({ rename: { kind: "none" } });
            } catch (cause) {
                signal.throwIfAborted();
                if (isSessionClosedFailure(cause)) {
                    set({ rename: { kind: "none" } });
                    return;
                }
                const rename = get().rename;
                let message: string;
                switch (rename.kind) {
                    case "refreshing":
                        message = "The title was saved, but its current value could not be refreshed.";
                        break;
                    case "sending":
                        message = "The rename could not be confirmed. Check the current title before saving again.";
                        break;
                    case "waiting":
                        message = "The Session could not connect to rename the conversation.";
                        break;
                    case "none":
                        return;
                    default:
                        return rename satisfies never;
                }
                set({ rename: { kind: "none" } });
                options.failed({ operation: "rename", message });
            }
        },
    }));
}
