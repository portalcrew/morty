import { createStore } from "zustand/vanilla";
import type { ApiTransport } from "../../services/api/api-transport.ts";
import { AnonymousIdentityApi, IdentityApiError } from "../../services/identity/anonymous-identity-api.ts";
import { readIdentityScope } from "../../services/identity/identity-scope-url.ts";
import {
    computerKey,
    rememberedComputers,
    storedTokenForComputer,
    withStoredAccessLock,
} from "../../services/identity/remembered-computers.ts";
import {
    accessEndedComputerEntry,
    accessEndedNoticeEntry,
    centralSessionStorage,
} from "../../services/session-storage/central-session-storage.ts";

type RemoteAccessState =
    | { readonly kind: "available" }
    | { readonly kind: "loading" }
    | { readonly kind: "unavailable"; readonly message: string }
    | { readonly kind: "confirming-end" }
    | { readonly kind: "ending" }
    | { readonly kind: "ended" }
    | { readonly kind: "failed"; readonly message: string };

interface RemoteAccessOperations {
    readonly currentAccessToken: (signal: AbortSignal) => Promise<string>;
    /** Ends the access this browser holds when it runs, while no other tab changes it. */
    readonly endRemoteAccess: (signal: AbortSignal) => Promise<void>;
}

export function createRemoteAccessOperations(options: {
    readonly fetchRequest: ApiTransport["fetch"];
    readonly origin: string;
    readonly identity: {
        readonly computerId: string;
        readonly getToken: (signal: AbortSignal) => Promise<string>;
    };
    readonly onEnded: () => void;
    /** The page's access as its owner confirms it, or null when it no longer opens the computer. */
    readonly currentAccess: (
        signal: AbortSignal,
    ) => Promise<{ readonly computerId: string; readonly computerToken: string } | null>;
    /** Tells the owner of the page's access that the Worker refused it; settles once the owner checked it. */
    readonly credentialRejected: () => Promise<void>;
}): RemoteAccessOperations {
    const api = new AnonymousIdentityApi(options);
    const currentAccessToken = async (signal: AbortSignal): Promise<string> => {
        const localIdentity = await options.currentAccess(signal);
        signal.throwIfAborted();
        return localIdentity?.computerId === options.identity.computerId
            ? localIdentity.computerToken
            : await options.identity.getToken(signal);
    };
    return {
        currentAccessToken,
        endRemoteAccess: async (signal) => {
            const scope = readIdentityScope();
            const computer =
                scope === null
                    ? undefined
                    : rememberedComputers().find((entry) => computerKey(entry.scope) === computerKey(scope));
            // Another tab may have replaced the access while the user confirmed; end the one held now. The Worker
            // checks it, so it is read without validating it again, which would wait for this same lock.
            try {
                await withStoredAccessLock(signal, async (access) =>
                    api.endRemoteAccess(
                        storedTokenForComputer(options.identity.computerId) ??
                            (await options.identity.getToken(signal)),
                        signal,
                        access,
                    ),
                );
            } catch (cause) {
                signal.throwIfAborted();
                if (cause instanceof IdentityApiError && cause.status === 401) {
                    await options.credentialRejected();
                }
                throw cause;
            }
            signal.throwIfAborted();
            centralSessionStorage.write(accessEndedNoticeEntry, "ended");
            centralSessionStorage.write(accessEndedComputerEntry, computer?.name || "the previous computer");
            options.onEnded();
        },
    };
}

export interface RemoteAccessStore {
    readonly state: RemoteAccessState;
    readonly requestEnd: (signal: AbortSignal) => Promise<void>;
    readonly cancel: () => void;
    readonly end: (signal: AbortSignal) => Promise<void>;
}

const operationSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

export const createRemoteAccessStore = (operations: RemoteAccessOperations) =>
    createStore<RemoteAccessStore>()((set, get) => ({
        state: { kind: "available" },
        requestEnd: async (signal) => {
            set({ state: { kind: "loading" } });
            try {
                await operations.currentAccessToken(operationSignal(signal));
                signal.throwIfAborted();
                set({ state: { kind: "confirming-end" } });
            } catch {
                // Access that no longer opens the computer may have ended this page's workspace, and this store with it.
                if (signal.aborted) {
                    return;
                }
                set({
                    state: {
                        kind: "unavailable",
                        message: "Couldn't prepare to end this access. Check your connection and try again.",
                    },
                });
            }
        },
        cancel: () => set({ state: { kind: "available" } }),
        end: async (signal) => {
            const state = get().state;
            if (state.kind !== "confirming-end" && state.kind !== "failed") {
                return;
            }
            set({ state: { kind: "ending" } });
            try {
                await operations.endRemoteAccess(operationSignal(signal));
                signal.throwIfAborted();
                set({ state: { kind: "ended" } });
            } catch {
                // Access that no longer opens the computer may have ended this page's workspace, and this store with it.
                if (signal.aborted) {
                    return;
                }
                set({
                    state: {
                        kind: "failed",
                        message: "We couldn't confirm whether this access ended. Check your connection and try again.",
                    },
                });
            }
        },
    }));
