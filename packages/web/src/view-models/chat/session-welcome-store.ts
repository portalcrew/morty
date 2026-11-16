import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import { centralSessionStorage, sessionWelcomeEntry } from "../../services/session-storage/central-session-storage.ts";

interface SessionWelcomeStore {
    readonly state: { readonly kind: "hidden" } | { readonly kind: "visible" };
    readonly connected: () => void;
    readonly dismiss: () => void;
    readonly suggestProgress: () => void;
}

export function createSessionWelcomeStore(options: {
    readonly computerId: string;
    readonly sessionTarget: NativeSessionTarget;
    readonly fillEmptyDraft: (text: string) => boolean;
}) {
    const entry = sessionWelcomeEntry(options.computerId, options.sessionTarget);
    return createStore<SessionWelcomeStore>()((set, get) => ({
        state: { kind: "hidden" },
        connected: () => {
            if (get().state.kind === "visible" || centralSessionStorage.read(entry) !== "pending") {
                return;
            }
            // Consume only after the session is connected, so retries can still
            // show the tip, while reloads and later visits do not repeat it.
            centralSessionStorage.remove(entry);
            set({ state: { kind: "visible" } });
        },
        dismiss: () => set({ state: { kind: "hidden" } }),
        suggestProgress: () => {
            if (get().state.kind !== "visible") {
                return;
            }
            if (options.fillEmptyDraft("Summarize the current task's progress and anything that needs my attention.")) {
                get().dismiss();
            }
        },
    }));
}
