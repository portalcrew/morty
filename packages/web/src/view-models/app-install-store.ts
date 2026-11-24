import { createStore } from "zustand/vanilla";
import type { AppInstall, InstallOffer } from "../services/device/app-install.ts";
import {
    appInstallSuggestionDismissedEntry,
    centralLocalStorage,
} from "../services/local-storage/central-local-storage.ts";
import type { Clock } from "../services/time/clock.ts";

export type AppInstallStoreApi = ReturnType<typeof createAppInstallStore>;

export type AppInstallState =
    | { readonly kind: "unavailable" }
    | { readonly kind: "offered"; readonly offer: InstallOffer }
    | { readonly kind: "prompting" }
    | { readonly kind: "installed" };

export interface AppInstallStore {
    readonly state: AppInstallState;
    readonly suggestionDismissed: boolean;
    readonly install: () => void;
    readonly dismissSuggestion: () => void;
}

export function appInstallSuggested(store: AppInstallStore): boolean {
    return store.state.kind === "offered" && !store.suggestionDismissed;
}

/** Whether the person can start installing Morty here; while the browser's dialog is open the entry stays, busy. */
export function appInstallEntryShown(state: AppInstallState): boolean {
    return state.kind === "offered" || state.kind === "prompting";
}

/**
 * This browser's offer to install Morty, and whether the person already turned the suggestion down. Declining the
 * browser's own dialog turns it down too, so the suggestion never returns; installing stays in the menu.
 */
export function createAppInstallStore(appInstall: AppInstall, clock: Clock, signal: AbortSignal) {
    const store = createStore<AppInstallStore>((set, get) => {
        const dismissSuggestion = () => {
            centralLocalStorage.write(appInstallSuggestionDismissedEntry, new Date(clock.now()).toISOString());
            set({ suggestionDismissed: true });
        };
        return {
            state: { kind: "unavailable" },
            suggestionDismissed: centralLocalStorage.read(appInstallSuggestionDismissedEntry) !== null,
            install: () => {
                const state = get().state;
                if (state.kind !== "offered") {
                    return;
                }
                set({ state: { kind: "prompting" } });
                // Runs synchronously from the click, so the browser still sees the person's activation.
                void state.offer.prompt().then(
                    (choice) => {
                        if (signal.aborted || get().state.kind !== "prompting") {
                            return;
                        }
                        if (choice === "accepted") {
                            set({ state: { kind: "installed" } });
                            return;
                        }
                        set({ state: { kind: "unavailable" } });
                        dismissSuggestion();
                    },
                    () => {
                        if (signal.aborted || get().state.kind !== "prompting") {
                            return;
                        }
                        set({ state: { kind: "unavailable" } });
                    },
                );
            },
            dismissSuggestion,
        };
    });
    appInstall.watch(
        {
            offered: (offer) => {
                const kind = store.getState().state.kind;
                if (kind === "offered" || kind === "unavailable") {
                    store.setState({ state: { kind: "offered", offer } });
                }
            },
            installed: () => store.setState({ state: { kind: "installed" } }),
        },
        signal,
    );
    return store;
}
