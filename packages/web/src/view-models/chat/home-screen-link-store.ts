import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { IdentityTransfer, SharingTerms } from "@/services/identity/anonymous-identity-api";
import { withChatToOpen } from "@/services/identity/chat-to-open";
import { withEncryptionAccess } from "./identity-sharing-store.ts";

type HomeScreenLinkState =
    | { readonly kind: "idle" }
    | { readonly kind: "copying" }
    | { readonly kind: "copied"; readonly expiresAt: string }
    | { readonly kind: "failed" };

export interface HomeScreenLinkStore {
    readonly state: HomeScreenLinkState;
    readonly copy: () => void;
    readonly dispose: () => void;
}

/**
 * Hands this browser's access to the Morty app on the Home Screen, which starts with storage of its own. Each copy
 * issues a new single-use link that expires in minutes, granting access until this browser's own access ends.
 */
export function createHomeScreenLinkStore(options: {
    readonly createTransfer: (terms: SharingTerms, signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly chat: NativeSessionTarget | null;
    readonly signal: AbortSignal;
    readonly onCopied: () => void;
}) {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([options.signal, lifetime.signal]);
    return createStore<HomeScreenLinkStore>()((set, get) => ({
        state: { kind: "idle" },
        dispose: () => lifetime.abort(),
        copy: () => {
            if (signal.aborted || get().state.kind === "copying") {
                return;
            }
            set({ state: { kind: "copying" } });
            const terms: SharingTerms = { operationId: crypto.randomUUID(), accessDuration: "30d", replaces: null };
            const link = options
                .createTransfer(terms, signal)
                .then((issued) => withEncryptionAccess(issued))
                .then((transfer) => ({ transfer, text: withChatToOpen(transfer.url, options.chat) }));
            // Safari keeps the tap's permission to write only for a clipboard item handed over during the tap, so the
            // link is written once it exists instead of after a later await.
            const written =
                typeof ClipboardItem === "function" && navigator.clipboard?.write !== undefined
                    ? navigator.clipboard.write([
                          new ClipboardItem({
                              "text/plain": link.then(({ text }) => new Blob([text], { type: "text/plain" })),
                          }),
                      ])
                    : link.then(({ text }) => navigator.clipboard.writeText(text));
            void Promise.all([link, written]).then(
                ([{ transfer }]) => {
                    if (signal.aborted) {
                        return;
                    }
                    set({ state: { kind: "copied", expiresAt: transfer.expiresAt } });
                    options.onCopied();
                },
                () => {
                    if (!signal.aborted) {
                        set({ state: { kind: "failed" } });
                    }
                },
            );
        },
    }));
}
