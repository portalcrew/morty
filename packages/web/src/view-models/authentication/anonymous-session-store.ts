import { createStore } from "zustand/vanilla";
import type { ApiTransport } from "../../services/api/api-transport.ts";
import {
    type AnonymousIdentity,
    AnonymousIdentityApi,
    type LostAccess,
} from "../../services/identity/anonymous-identity-api.ts";
import {
    hasIdentityScope,
    leaveComputerAddress,
    readIdentityScope,
} from "../../services/identity/identity-scope-url.ts";
import {
    computerAddress,
    rememberComputerVisit,
    rememberedComputers,
    resumesComputer,
    settleResumedComputer,
    storedToken,
} from "../../services/identity/remembered-computers.ts";
import {
    accessEndedComputerEntry,
    accessEndedNoticeEntry,
    centralSessionStorage,
} from "../../services/session-storage/central-session-storage.ts";
import { type Clock, systemClock } from "../../services/time/clock.ts";

export type ActiveAnonymousSession = {
    readonly kind: "active";
    readonly identity: AnonymousIdentity;
    readonly entry: "address" | "restore";
    readonly notice: string | null;
};

type AnonymousSessionState =
    | { readonly kind: "loading" }
    | {
          readonly kind: "setup";
          readonly notice: "access-ended" | "none";
          readonly returnHref: string | null;
      }
    | ActiveAnonymousSession
    | { readonly kind: "invalid-link"; readonly continueHref: string | null }
    | { readonly kind: "unpaired" }
    | { readonly kind: "failed"; readonly retrying: boolean };

export interface AnonymousSessionStore {
    readonly state: AnonymousSessionState;
    readonly authorize: (signal: AbortSignal) => Promise<void>;
    readonly load: (signal: AbortSignal, options?: { readonly fromFailedRetry?: boolean }) => Promise<void>;
    /**
     * The page's access as the Worker confirms it now, with the token this browser currently stores for it. Access
     * that no longer opens the page's computer is left, and null is returned; so is null when no access is active.
     */
    readonly currentAccess: (signal: AbortSignal) => Promise<AnonymousIdentity | null>;
    /**
     * A request made with the page's access was refused as unauthenticated. The access is confirmed again, once for
     * requests refused together, and left when it no longer opens the computer. Settles once that check has.
     */
    readonly credentialRejected: (signal: AbortSignal) => Promise<void>;
    /**
     * Another tab removed the access this page works with: it ended that access, found it ended, or replaced it with
     * access for someone else. Either way this browser no longer holds it, so the page leaves its computer as it does
     * for ended access.
     */
    readonly storedAccessRemoved: () => void;
}

/** The application owns and releases the workspace at these explicit transitions. */
export type AnnounceIdentity = (session: ActiveAnonymousSession | null) => void;

export const createAnonymousSessionStore = (
    fetchRequest: ApiTransport["fetch"],
    origin: string,
    onIdentityChanged: AnnounceIdentity,
    clock: Clock = systemClock,
) =>
    createStore<AnonymousSessionStore>()((set, get) => {
        const api = new AnonymousIdentityApi({ fetchRequest, origin });
        const activate = (identity: AnonymousIdentity, entry: "address" | "restore", notice: string | null) => {
            rememberComputerVisit(identity, clock.now());
            const state: ActiveAnonymousSession = { kind: "active", identity, entry, notice };
            set({ state });
            onIdentityChanged(state);
        };
        /**
         * The page's computer no longer opens with the access this browser had for it. Ended access is explained once
         * and the page leaves that computer's address; other access that stopped opening it reports the link invalid.
         * Neither switches to another computer by itself.
         */
        const leave = (check: LostAccess) => {
            const fallback = rememberedComputers().length > 0 ? "/" : null;
            switch (check.kind) {
                case "revoked":
                    leaveComputerAddress();
                    set({ state: { kind: "setup", notice: "access-ended", returnHref: fallback } });
                    return;
                case "gone":
                    set({ state: { kind: "invalid-link", continueHref: fallback } });
                    return;
            }
        };
        /**
         * The only check of the page's access. It forgets access that no longer opens the computer, so whatever finds
         * that out is also what releases the workspace and explains it.
         */
        const currentAccess = async (signal: AbortSignal): Promise<AnonymousIdentity | null> => {
            const state = get().state;
            if (state.kind !== "active") {
                return null;
            }
            // Access this browser no longer holds was forgotten by the check that found out it ended, which explains
            // it, or by another tab, which reports it here; not finding it here is no verdict of its own.
            if (storedToken(state.identity.computerId) === null) {
                return null;
            }
            const check = await api.checkScope(state.identity, signal);
            signal.throwIfAborted();
            if (check.kind === "open") {
                return check.identity;
            }
            if (get().state === state) {
                onIdentityChanged(null);
                leave(check);
            }
            return null;
        };
        let confirming: Promise<void> | null = null;
        return {
            state: { kind: "loading" },
            authorize: async (signal) => {
                const state = get().state;
                if (state.kind !== "active") {
                    throw new Error("Anonymous identity is unavailable.");
                }
                if (readIdentityScope()?.computerId !== state.identity.computerId) {
                    throw new Error("Anonymous identity changed.");
                }
                if ((await currentAccess(signal)) === null) {
                    throw new Error("Anonymous identity is unavailable.");
                }
            },
            currentAccess,
            credentialRejected: async (signal) => {
                confirming ??= currentAccess(signal)
                    .then(
                        () => undefined,
                        // An unavailable check is not evidence that access ended; the refused request reports itself.
                        () => undefined,
                    )
                    .finally(() => {
                        confirming = null;
                    });
                await confirming;
            },
            storedAccessRemoved: () => {
                const state = get().state;
                if (state.kind !== "active" || storedToken(state.identity.computerId) !== null) {
                    return;
                }
                onIdentityChanged(null);
                leave({ kind: "revoked" });
            },
            load: async (signal, options) => {
                const fromFailedRetry = options?.fromFailedRetry === true;
                if (fromFailedRetry) {
                    set({ state: { kind: "failed", retrying: true } });
                } else {
                    set({ state: { kind: "loading" } });
                    onIdentityChanged(null);
                }
                try {
                    const setupPath = window.location.pathname === "/setup" || window.location.pathname === "/setup/";
                    if (setupPath && !hasIdentityScope()) {
                        set({
                            state: {
                                kind: "setup",
                                notice: "none",
                                returnHref: rememberedComputers().length > 0 ? "/" : null,
                            },
                        });
                        return;
                    }
                    if (hasIdentityScope()) {
                        const scope = readIdentityScope();
                        if (scope !== null && storedToken(scope.computerId) === null) {
                            set({ state: { kind: "unpaired" } });
                            return;
                        }
                        // A place this browser remembered falls back to the computer's home when it is gone; a link
                        // someone gave the user reports that it no longer opens.
                        const entry = resumesComputer() ? "restore" : "address";
                        if (scope === null) {
                            leave({ kind: "gone" });
                            return;
                        }
                        const check = await api.checkScope(scope, signal);
                        signal.throwIfAborted();
                        if (check.kind !== "open") {
                            leave(check);
                            return;
                        }
                        const identity = check.identity;
                        settleResumedComputer();
                        if (setupPath) {
                            set({ state: { kind: "setup", notice: "none", returnHref: "/" } });
                            return;
                        }
                        activate(identity, entry, null);
                        return;
                    }
                    // The computer whose access ended: this tab ended it before reloading, or the Worker reports that
                    // access to a remembered computer was revoked.
                    let endedName =
                        centralSessionStorage.read(accessEndedNoticeEntry) === "ended"
                            ? (centralSessionStorage.read(accessEndedComputerEntry) ?? "the previous computer")
                            : null;
                    // Only the requested computer gates entry. An unrelated slow
                    // computer must not block a valid recent one.
                    for (const computer of rememberedComputers()) {
                        const check = await api.checkScope(computer.scope, signal);
                        signal.throwIfAborted();
                        if (check.kind === "revoked") {
                            endedName ??= computer.name || "the previous computer";
                            continue;
                        }
                        if (check.kind === "gone") {
                            continue;
                        }
                        const identity = check.identity;
                        const address = new URL(computerAddress(identity, computer.destination), origin);
                        window.history.replaceState(window.history.state, "", address);
                        centralSessionStorage.remove(accessEndedNoticeEntry);
                        centralSessionStorage.remove(accessEndedComputerEntry);
                        activate(
                            identity,
                            "restore",
                            endedName === null
                                ? null
                                : `Access to ${endedName} ended. You are now on ${computer.name || "your next computer"}.`,
                        );
                        return;
                    }
                    centralSessionStorage.remove(accessEndedNoticeEntry);
                    centralSessionStorage.remove(accessEndedComputerEntry);
                    set({
                        state: {
                            kind: "setup",
                            notice: endedName === null ? "none" : "access-ended",
                            returnHref: null,
                        },
                    });
                } catch {
                    if (signal.aborted) {
                        return;
                    }
                    set({ state: { kind: "failed", retrying: false } });
                }
            },
        };
    });
