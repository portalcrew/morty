import { createStore, type StoreApi } from "zustand/vanilla";
import type { BotChatApi, ChatComputer } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer, SharingTerms } from "../../services/identity/anonymous-identity-api.ts";
import type { Clock } from "../../services/time/clock.ts";
import { createIdentitySharingStore, type IdentitySharingStore } from "./identity-sharing-store.ts";
import { createNativeSessionStore, type NativeSessionStore } from "./native-session-store.ts";
import type { OpenMortySession } from "./open-session.ts";

export type SidebarDialogs = StoreApi<SidebarDialogsState>;

interface SidebarDialogsState {
    readonly mobileNavOpen: boolean;
    readonly mobileSessionsOpen: boolean;
    /** Timestamp until which the mobile sessions sheet ignores outside-pointer dismissals. */
    readonly mobileSheetDismissLockedUntil: number;
    readonly nativeDialog: StoreApi<NativeSessionStore> | null;
    /** A closed dialog's store, kept so reopening the sheet returns to the session the user was reading. */
    readonly retainedNativeDialog: StoreApi<NativeSessionStore> | null;
    /** The phone sheet's drill-down step: the session list, or the previewed session's detail. */
    readonly nativeDialogStep: "list" | "detail";
    readonly sharing: StoreApi<IdentitySharingStore> | null;
    readonly openMobileNav: () => void;
    readonly closeMobileNav: () => void;
    /** Opens the mobile recent-sessions sheet and locks outside-pointer dismissal briefly so the same tap that opened it cannot close it. */
    readonly openMobileRecentSessions: () => void;
    readonly closeMobileRecentSessions: () => void;
    /** Closes the mobile recent-sessions sheet from an outside-pointer dismissal, ignored while the dismissal lock is held. */
    readonly dismissMobileRecentSessions: () => void;
    readonly openNativeDialog: () => void;
    readonly closeNativeDialog: () => void;
    /** Stops the dialog workflow for good: after a successful open, and when the workspace ends. */
    readonly discardNativeDialog: () => void;
    /** The phone sheet drills into the previewed session's detail. */
    readonly openNativeSessionDetail: () => void;
    /** The phone sheet returns from the detail to the session list. */
    readonly backToNativeSessionList: () => void;
    /** The Computer configuration the page follows changed; an open Open Session dialog follows it. */
    readonly computerChanged: () => void;
    readonly openSharing: () => void;
    readonly closeSharing: () => void;
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
    readonly requests: Pick<BotChatApi, "nativeSessions" | "nativeSession" | "forkNativeSession">;
    /** The Computer the page follows. */
    readonly computer: () => ChatComputer | null;
    readonly createTransfer: (terms: SharingTerms, signal: AbortSignal) => Promise<IdentityTransfer>;
    readonly onOpenSession: (session: OpenMortySession) => void;
    readonly onOpenedSession: () => void;
}): SidebarDialogs {
    const { clock, requests, computer, createTransfer, onOpenSession, onOpenedSession } = options;
    return createStore<SidebarDialogsState>()((set, get) => ({
        mobileNavOpen: false,
        mobileSessionsOpen: false,
        mobileSheetDismissLockedUntil: 0,
        nativeDialog: null,
        retainedNativeDialog: null,
        nativeDialogStep: "list",
        sharing: null,
        openMobileNav: () => set({ mobileNavOpen: true }),
        closeMobileNav: () => set({ mobileNavOpen: false }),
        openMobileRecentSessions: () =>
            set({
                mobileNavOpen: false,
                mobileSessionsOpen: true,
                mobileSheetDismissLockedUntil: clock.now() + MOBILE_SHEET_DISMISS_LOCK_MILLISECONDS,
            }),
        closeMobileRecentSessions: () => set({ mobileSessionsOpen: false }),
        dismissMobileRecentSessions: () => {
            if (clock.now() < get().mobileSheetDismissLockedUntil) {
                return;
            }
            set({ mobileSessionsOpen: false });
        },
        openNativeDialog: () => {
            if (get().nativeDialog !== null) {
                return;
            }
            const retained = get().retainedNativeDialog;
            if (retained !== null) {
                set({ nativeDialog: retained, retainedNativeDialog: null, nativeDialogStep: "list" });
                // Refresh the listing for the Computer the page follows now; the
                // previewed entry stays selected when the refresh still lists it.
                retained.getState().start();
                return;
            }
            const store = createNativeSessionStore(requests, computer, (session) => {
                onOpenSession(session);
                get().discardNativeDialog();
                onOpenedSession();
            });
            store.getState().start();
            set({ nativeDialog: store, nativeDialogStep: "list" });
        },
        closeNativeDialog: () => {
            const dialog = get().nativeDialog;
            if (dialog === null) {
                return;
            }
            set({ nativeDialog: null, retainedNativeDialog: dialog });
        },
        discardNativeDialog: () => {
            const { nativeDialog, retainedNativeDialog } = get();
            nativeDialog?.getState().stop();
            retainedNativeDialog?.getState().stop();
            set({ nativeDialog: null, retainedNativeDialog: null, nativeDialogStep: "list" });
        },
        openNativeSessionDetail: () => set({ nativeDialogStep: "detail" }),
        backToNativeSessionList: () => set({ nativeDialogStep: "list" }),
        computerChanged: () => {
            get().nativeDialog?.getState().computerChanged();
        },
        openSharing: () => {
            if (get().sharing !== null) {
                return;
            }
            const sharing = createIdentitySharingStore(createTransfer, clock);
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
    }));
}
