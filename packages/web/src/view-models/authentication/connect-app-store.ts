import { createStore } from "zustand/vanilla";

export type ConnectAppStoreApi = ReturnType<typeof createConnectAppStore>;

type ConnectAppState =
    | { readonly kind: "waiting" }
    | { readonly kind: "reading" }
    | { readonly kind: "not-a-link" }
    | { readonly kind: "clipboard-unavailable" }
    | { readonly kind: "opening" };

export interface ConnectAppStore {
    readonly state: ConnectAppState;
    readonly paste: () => void;
    readonly submit: (text: string) => void;
}

/** A Morty link that adds a device, on this Morty, or null for anything else the person pasted. */
function connectionLink(text: string, origin: string): URL | null {
    let url: URL;
    try {
        url = new URL(text.trim());
    } catch {
        return null;
    }
    const code = new URLSearchParams(url.hash.slice(1)).get("code");
    return url.origin === origin && url.pathname === "/continue" && code !== null && code.length > 0 ? url : null;
}

/**
 * The Home Screen app on iOS keeps storage apart from Safari, so it starts without the access Safari holds. The person
 * copies a link in Safari and pastes it here; opening it redeems the link like any other continuation link.
 */
export function createConnectAppStore(origin: string) {
    return createStore<ConnectAppStore>()((set, get) => {
        const open = (text: string) => {
            const link = connectionLink(text, origin);
            if (link === null) {
                set({ state: { kind: "not-a-link" } });
                return;
            }
            set({ state: { kind: "opening" } });
            window.location.assign(link);
        };
        return {
            state: { kind: "waiting" },
            paste: () => {
                const kind = get().state.kind;
                if (kind === "reading" || kind === "opening") {
                    return;
                }
                set({ state: { kind: "reading" } });
                // Called from the tap, so iOS shows its Paste confirmation.
                void navigator.clipboard.readText().then(open, () => set({ state: { kind: "clipboard-unavailable" } }));
            },
            submit: (text) => {
                if (get().state.kind !== "opening") {
                    open(text);
                }
            },
        };
    });
}
