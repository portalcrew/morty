import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BotChatApi, ChatComputer } from "../../services/chat/bot-chat-api.ts";
import type {
    AccessDurationOptions,
    IdentityTransfer,
    SharingTerms,
} from "../../services/identity/anonymous-identity-api.ts";
import type { Clock } from "../../services/time/clock.ts";
import type { AccessHolder } from "./access-presentation.ts";
import { createHomeScreenLinkStore, type HomeScreenLinkStore } from "./home-screen-link-store.ts";
import { createIdentitySharingStore, type IdentitySharingStore } from "./identity-sharing-store.ts";
import { createNativeSessionStore, type NativeSessionStore } from "./native-session-store.ts";
import type { OpenMortySession } from "./open-session.ts";

export type SidebarDialogs = StoreApi<SidebarDialogsState>;

type MobilePanel =
    | { readonly kind: "closed" }
    | { readonly kind: "nav" }
    | {
          readonly kind: "sessions";
          readonly dismissLockedUntil: number;
      };

interface SidebarDialogsState {
    readonly mobilePanel: MobilePanel;
    readonly nativeDialog: {
        readonly store: StoreApi<NativeSessionStore>;
        readonly step: "list" | "detail";
    } | null;
    /** A closed dialog's store, kept so reopening the sheet returns to the session the user was reading. */
    readonly retainedNativeDialog: StoreApi<NativeSessionStore> | null;
    readonly sharing: StoreApi<IdentitySharingStore> | null;
    readonly homeScreen: StoreApi<HomeScreenLinkStore> | null;
    readonly openMobileNav: () => void;
    readonly closeMobileNav: () => void;
    readonly closeMobilePanel: () => void;
    /** Opens the mobile recent-sessions sheet and locks outside-pointer dismissal briefly so the same tap that opened it cannot close it. */
    readonly openMobileRecentSessions: () => void;
    readonly closeMobileRecentSessions: () => void;
    readonly dismissMobileRecentSessions: () => void;
    readonly openNativeDialog: () => void;
    readonly closeNativeDialog: () => void;
    readonly discardNativeDialog: () => void;
    readonly openNativeSessionDetail: () => void;
    readonly backToNativeSessionList: () => void;
    readonly computerChanged: () => void;
    readonly openSharing: () => void;
    readonly closeSharing: () => void;
    /** Opens the steps for adding Morty to the Home Screen, handing over the chat open now. */
    readonly openHomeScreen: (chat: NativeSessionTarget | null) => void;
    readonly closeHomeScreen: () => void;
}

/**
 * Owns the sidebar's ephemeral UI state and dialog workflows so the view
 * subscribes with `useStore` and wires only DOM callbacks. The native session
 * dialog's store is created when the dialog opens and kept when it closes, so
 * reopening the sheet returns to the session the user was reading; a successful
 * open and the end of the workspace stop it for good.
 */

const MOBILE_SHEET_DISMISS_LOCK_MILLISECONDS = 450;

export function createSidebarDialogs(options: {
    readonly clock: Clock;
    readonly signal: () => AbortSignal;
    readonly requests: Pick<
        BotChatApi,
        "nativeSessions" | "nativeSession" | "forkNativeSession" | "importNativeSession"
    >;
    readonly computer: () => ChatComputer | null;
    readonly createTransfer: (terms: SharingTerms, signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly sharingTerms: (signal: AbortSignal) => Promise<AccessDurationOptions>;
    readonly onOpenSession: (session: OpenMortySession) => void;
    readonly onOpenedSession: () => void;
    readonly onHomeScreenLinkCopied: () => void;
    readonly accessHolder: AccessHolder;
}): SidebarDialogs {
    const { clock, requests, computer, createTransfer, sharingTerms, onOpenSession, onOpenedSession } = options;
    return createStore<SidebarDialogsState>()((set, get) => ({
        mobilePanel: { kind: "closed" },
        nativeDialog: null,
        retainedNativeDialog: null,
        sharing: null,
        homeScreen: null,
        openMobileNav: () => set({ mobilePanel: { kind: "nav" } }),
        closeMobileNav: () => {
            if (get().mobilePanel.kind === "nav") {
                set({ mobilePanel: { kind: "closed" } });
            }
        },
        closeMobilePanel: () => set({ mobilePanel: { kind: "closed" } }),
        openMobileRecentSessions: () =>
            set({
                mobilePanel: {
                    kind: "sessions",
                    dismissLockedUntil: clock.now() + MOBILE_SHEET_DISMISS_LOCK_MILLISECONDS,
                },
            }),
        closeMobileRecentSessions: () => {
            if (get().mobilePanel.kind === "sessions") {
                set({ mobilePanel: { kind: "closed" } });
            }
        },
        dismissMobileRecentSessions: () => {
            const panel = get().mobilePanel;
            if (panel.kind === "sessions" && clock.now() >= panel.dismissLockedUntil) {
                set({ mobilePanel: { kind: "closed" } });
            }
        },
        openNativeDialog: () => {
            if (get().nativeDialog !== null) {
                return;
            }
            const retained = get().retainedNativeDialog;
            if (retained !== null) {
                set({ nativeDialog: { store: retained, step: "list" }, retainedNativeDialog: null });
                retained.getState().start();
                return;
            }
            const store = createNativeSessionStore(requests, computer, (session) => {
                onOpenSession(session);
                get().discardNativeDialog();
                onOpenedSession();
            });
            store.getState().start();
            set({ nativeDialog: { store, step: "list" } });
        },
        closeNativeDialog: () => {
            const dialog = get().nativeDialog;
            if (dialog === null) {
                return;
            }
            set({ nativeDialog: null, retainedNativeDialog: dialog.store });
        },
        discardNativeDialog: () => {
            const { nativeDialog, retainedNativeDialog } = get();
            nativeDialog?.store.getState().stop();
            retainedNativeDialog?.getState().stop();
            set({ nativeDialog: null, retainedNativeDialog: null });
        },
        openNativeSessionDetail: () => {
            const dialog = get().nativeDialog;
            if (dialog !== null) {
                set({ nativeDialog: { ...dialog, step: "detail" } });
            }
        },
        backToNativeSessionList: () => {
            const dialog = get().nativeDialog;
            if (dialog !== null) {
                set({ nativeDialog: { ...dialog, step: "list" } });
            }
        },
        computerChanged: () => {
            get().nativeDialog?.store.getState().computerChanged();
        },
        openSharing: () => {
            if (get().sharing !== null) {
                return;
            }
            const sharing = createIdentitySharingStore(createTransfer, sharingTerms, clock, options.accessHolder);
            set({ sharing });
            sharing.getState().start(options.signal());
        },
        closeSharing: () => {
            const store = get().sharing;
            if (store === null) {
                return;
            }
            store.getState().dispose();
            set({ sharing: null });
        },
        openHomeScreen: (chat) => {
            if (get().homeScreen !== null) {
                return;
            }
            const homeScreen = createHomeScreenLinkStore({
                createTransfer,
                chat,
                signal: options.signal(),
                onCopied: options.onHomeScreenLinkCopied,
            });
            set({ homeScreen });
        },
        closeHomeScreen: () => {
            get().homeScreen?.getState().dispose();
            set({ homeScreen: null });
        },
    }));
}
