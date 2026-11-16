import { createStore } from "zustand/vanilla";
import type { SetupHandoff } from "../services/device/setup-handoff.ts";

export type SendLinkStoreApi = ReturnType<typeof createSendLinkStore>;

type SendLinkState = { readonly kind: "idle" } | { readonly kind: "sending" } | { readonly kind: "failed" };

export type SetupHandoffModel =
    | { readonly kind: "copy-prompt" }
    | { readonly kind: "share"; readonly sendLink: SendLinkStoreApi }
    | { readonly kind: "copy-link" };

function createSendLinkStore(share: (data: ShareData) => Promise<void>) {
    const lifetime = new AbortController();
    return createStore<{
        readonly state: SendLinkState;
        readonly send: (data: ShareData) => void;
        readonly close: () => void;
    }>((set, get) => ({
        state: { kind: "idle" },
        send: (data) => {
            // A share sheet is already open; the browser rejects a second one.
            if (lifetime.signal.aborted || get().state.kind === "sending") {
                return;
            }
            set({ state: { kind: "sending" } });
            // Runs synchronously from the click, so the browser still sees the person's activation.
            void share(data).then(
                () => {
                    if (lifetime.signal.aborted) {
                        return;
                    }
                    set({ state: { kind: "idle" } });
                },
                (cause: unknown) => {
                    if (lifetime.signal.aborted) {
                        return;
                    }
                    // Dismissing the share sheet is a cancellation, not a failure.
                    const dismissed = cause instanceof DOMException && cause.name === "AbortError";
                    set({ state: dismissed ? { kind: "idle" } : { kind: "failed" } });
                },
            );
        },
        close: () => lifetime.abort(),
    }));
}

export function setupHandoffModel(handoff: SetupHandoff): SetupHandoffModel {
    switch (handoff.kind) {
        case "copy-prompt":
            return { kind: "copy-prompt" };
        case "send-link":
            return handoff.share === null
                ? { kind: "copy-link" }
                : { kind: "share", sendLink: createSendLinkStore(handoff.share) };
    }
}
