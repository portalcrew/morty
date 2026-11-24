import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import { IdentityApiError, type SharingTerms } from "@/services/identity/anonymous-identity-api";
import { withChatToOpen } from "@/services/identity/chat-to-open";
import type { SharedAccess } from "@/services/identity/shared-access";

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
    readonly shareAccess: (terms: SharingTerms, signal: AbortSignal) => Promise<SharedAccess>;
    readonly chat: NativeSessionTarget | null;
    readonly signal: AbortSignal;
    readonly onCopied: () => void;
}) {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([options.signal, lifetime.signal]);
    // The last link copied here. Copying again replaces it, so at most one link from this sheet still opens.
    let copiedCode: string | null = null;
    const issue = async (): Promise<SharedAccess> => {
        const terms = (replaces: string | null): SharingTerms => ({
            operationId: crypto.randomUUID(),
            accessDuration: "30d",
            replaces,
        });
        try {
            return await options.shareAccess(terms(copiedCode), signal);
        } catch (cause) {
            // The earlier link was already used or expired, so nothing is left to replace.
            if (copiedCode !== null && cause instanceof IdentityApiError && cause.code === "TRANSFER_CONFLICT") {
                return await options.shareAccess(terms(null), signal);
            }
            throw cause;
        }
    };
    return createStore<HomeScreenLinkStore>()((set, get) => ({
        state: { kind: "idle" },
        dispose: () => lifetime.abort(),
        copy: () => {
            if (signal.aborted || get().state.kind === "copying") {
                return;
            }
            set({ state: { kind: "copying" } });
            const link = issue().then((shared) => ({ shared, text: withChatToOpen(shared.link, options.chat) }));
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
                ([{ shared }]) => {
                    if (signal.aborted) {
                        return;
                    }
                    copiedCode = shared.code;
                    set({ state: { kind: "copied", expiresAt: shared.expiresAt } });
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
