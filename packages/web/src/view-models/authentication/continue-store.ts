import {
    type ComputerEncryptionAccess,
    computerEncryptionAccessCodec,
    E2EError,
    importE2EPublicKey,
    openSetupHandoff,
    readSetupHandoffLink,
    SetupHandoffError,
    type SetupHandoffLink,
    setupHandoffLookupId,
} from "@portalcrew/morty-client";
import { isIdentifier, MAX_WORKSPACE_PATH_LENGTH, type NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { base64urlnopad } from "@scure/base";
import { createStore } from "zustand/vanilla";
import type { ApiTransport } from "@/services/api/api-transport";
import { BotChatApi } from "@/services/chat/bot-chat-api";
import { saveLastCwdPreference, saveRecentCwdPreference } from "@/services/chat/last-cwd-preference";
import { type DaemonDiagnosticsSource, recordBrowserError } from "@/services/diagnostics/browser-diagnostics";
import {
    type AnonymousIdentity,
    AnonymousIdentityApi,
    IdentityApiError,
    transferCodeComputer,
} from "@/services/identity/anonymous-identity-api";
import { chatToOpen } from "@/services/identity/chat-to-open";
import { encodeIdentityScope, hasIdentityScope, readIdentityScope } from "@/services/identity/identity-scope-url";
import {
    computerKey,
    rememberComputerEncryption,
    rememberedComputers,
    replacedToken,
    storedToken,
} from "@/services/identity/remembered-computers";
import { centralSessionStorage, sessionWelcomeEntry } from "@/services/session-storage/central-session-storage";
import { formatError } from "@/view-models/format-error";

export type ContinueStoreApi = ReturnType<typeof createContinueStore>;

/** Where a link's Computer encryption access comes from: a sealed setup link's contents, or the link's fragment. */
type HandoffEncryption =
    | { readonly kind: "fragment" }
    | { readonly kind: "sealed"; readonly access: ComputerEncryptionAccess };
type SessionHandoff = {
    readonly harness: string;
    readonly sessionId: string;
    readonly workspace: string;
    readonly encryption: HandoffEncryption;
};
export type ContinueState =
    | { readonly kind: "handoff-unsealing"; readonly link: SetupHandoffLink }
    | { readonly kind: "handoff-failed"; readonly link: SetupHandoffLink; readonly message: string }
    | {
          readonly kind: "session-opening";
          readonly code: string;
          readonly handoff: SessionHandoff;
      }
    | {
          readonly kind: "session-resuming";
          readonly handoff: SessionHandoff;
          readonly identity: AnonymousIdentity;
      }
    | {
          readonly kind: "session-failed";
          readonly handoff: SessionHandoff;
          readonly message: string;
          /**
           * The redeemed access. Opening the original session failed, but this
           * access still lets the user enter Morty home instead.
           */
          readonly identity: AnonymousIdentity;
      }
    | {
          readonly kind: "redeem-failed";
          readonly code: string;
          readonly handoff: SessionHandoff;
          readonly message: string;
      }
    | { readonly kind: "link-unavailable"; readonly recovery: "setup" | "share"; readonly message: string }
    | { readonly kind: "identity-redeeming"; readonly code: string }
    | { readonly kind: "failed"; readonly code: string; readonly message: string }
    | { readonly kind: "invalid" };

export interface ContinueStore {
    readonly state: ContinueState;
    readonly start: () => void;
    readonly cancel: () => void;
    readonly redeem: (signal: AbortSignal) => Promise<void>;
    readonly retry: () => void;
    readonly enterMorty: () => void;
    readonly diagnostics: DaemonDiagnosticsSource | null;
}

function initialState(): ContinueState {
    const sealed = readSetupHandoffLink(window.location.hash);
    if (sealed !== null) {
        return { kind: "handoff-unsealing", link: sealed };
    }
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const code = fragment.get("code");
    const query = new URLSearchParams(window.location.search);
    const harness = query.get("harness");
    const sessionId = query.get("sessionId");
    const workspace = fragment.get("workspace");
    if (code === null || code.length === 0) {
        return { kind: "invalid" };
    }
    if (harness === null && sessionId === null && workspace === null) {
        return { code, kind: "identity-redeeming" };
    }
    if (
        harness === null ||
        !isIdentifier(harness) ||
        sessionId === null ||
        !isIdentifier(sessionId) ||
        workspace === null ||
        workspace.length === 0 ||
        workspace.length > MAX_WORKSPACE_PATH_LENGTH ||
        workspace.includes("\0")
    ) {
        return { kind: "invalid" };
    }
    return {
        code,
        handoff: { harness, sessionId, workspace, encryption: { kind: "fragment" } },
        kind: "session-opening",
    };
}

function identityDestination(path: "/" | "/chat", identity: AnonymousIdentity): URL {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("identity", encodeIdentityScope({ computerId: identity.computerId }));
    return url;
}

/** Where a redeemed link opens: the chat it names, or Morty home. */
function redeemedDestination(identity: AnonymousIdentity, chat: NativeSessionTarget | null): URL {
    if (chat === null) {
        return identityDestination("/", identity);
    }
    const url = identityDestination("/chat", identity);
    url.searchParams.set("harness", chat.harness);
    url.searchParams.set("sessionId", chat.sessionId);
    return url;
}

/**
 * Redeeming a transfer code is the only way to obtain access for a link that
 * was never opened in this browser. A link that no longer opens may not be this
 * browser's only access to its Computer: another link it opened, or the
 * computer's own access, can still open it. So a failed redemption falls back to
 * the access this browser still holds for the same Computer.
 */
export const createContinueStore = (transport: ApiTransport) => {
    // Snapshot the fragment locally. It is never included in the redemption request or any relay call.
    const encryptionFragment = new URLSearchParams(window.location.hash.slice(1));
    const linkedChat = chatToOpen(window.location.search);
    const fragmentEncryption = (): ComputerEncryptionAccess | null => {
        const encoded = encryptionFragment.get("e2e");
        if (encoded === null) {
            return null;
        }
        if (encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
            throw new E2EError("e2e_invalid_access");
        }
        return computerEncryptionAccessCodec.decode(
            new TextDecoder("utf-8", { fatal: true }).decode(base64urlnopad.decode(encoded)),
        );
    };
    const retainEncryption = async (
        identity: AnonymousIdentity,
        encryption: HandoffEncryption,
        signal: AbortSignal,
    ): Promise<void> => {
        const access = encryption.kind === "sealed" ? encryption.access : fragmentEncryption();
        if (access === null) {
            return;
        }
        if (access.computerId !== identity.computerId) {
            throw new E2EError("e2e_invalid_access");
        }
        await importE2EPublicKey(access.computerE2EPublicKey);
        signal.throwIfAborted();
        rememberComputerEncryption(access);
    };
    const fetchRequest = transport.fetch;
    let attempt: AbortController | null = null;
    const store = createStore<ContinueStore>()((set, get) => {
        const showRetryableFailure = (
            state: Extract<ContinueState, { readonly kind: "session-opening" | "identity-redeeming" }>,
            cause: unknown,
        ) => {
            const message = formatError(cause, "Check your connection and try again.");
            set({
                state:
                    state.kind === "identity-redeeming"
                        ? { kind: "failed", code: state.code, message }
                        : { kind: "redeem-failed", code: state.code, handoff: state.handoff, message },
            });
        };
        /**
         * Opens the handoff session with an already-redeemed access. The
         * identity stays in the resulting states, so a retry reuses it instead
         * of redeeming the transfer code again.
         */
        const openSession = async (
            handoff: SessionHandoff,
            identity: AnonymousIdentity,
            signal: AbortSignal,
        ): Promise<void> => {
            set({
                diagnostics: null,
                state: { handoff, identity, kind: "session-resuming" },
            });
            const chat = new BotChatApi({
                fetchRequest,
                sessionTransport: () => transport.computerTransport(identity.computerId),
                origin: window.location.origin,
                computerId: identity.computerId,
                // The access this browser holds: another tab may have replaced the one this link issued.
                getToken: async () => storedToken(identity.computerId) ?? identity.computerToken,
                replacedToken: (rejected, signal) => replacedToken(identity.computerId, rejected, signal),
                waitForChange: async () => {
                    throw new Error("Computer updates are unavailable while continuing this session.");
                },
            });
            set({
                diagnostics: {
                    computerId: identity.computerId,
                    harness: handoff.harness,
                    sessionId: handoff.sessionId,
                    read: (parent) => chat.daemonDiagnostics(parent),
                    readNetwork: (parent) => chat.networkDiagnostic(parent),
                },
            });
            try {
                // A handoff supplies a requested path, never filesystem authority.
                // Resolve it through the Computer before recording a browser preference.
                const configuration = await chat.computerConfiguration(signal);
                const directory = await chat.directory(handoff.workspace, signal);
                signal.throwIfAborted();
                saveLastCwdPreference(configuration.computer.computerId, handoff.harness, directory.directory);
                saveRecentCwdPreference(identity.computerId, {
                    directory: directory.directory,
                    directoryLabel: directory.directoryLabel,
                });
                const session = await chat.continueNativeSession(handoff.harness, handoff.sessionId, signal);
                signal.throwIfAborted();
                const visited = rememberedComputers().some(
                    (computer) => computerKey(computer.scope) === computerKey(identity) && computer.lastUsedAt > 0,
                );
                if (!visited) {
                    centralSessionStorage.write(sessionWelcomeEntry(identity.computerId, session.target), "pending");
                }
                const destination = identityDestination("/chat", identity);
                destination.searchParams.set("harness", session.target.harness);
                destination.searchParams.set("sessionId", session.target.sessionId);
                window.location.replace(destination);
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                recordBrowserError("continue-native-session", cause);
                set({
                    state: {
                        handoff,
                        identity,
                        kind: "session-failed",
                        message: formatError(cause, "This transfer link is unavailable."),
                    },
                });
            }
        };
        /**
         * Access this browser already holds for the Computer: the explicit scope, or a remembered scope for that exact
         * Computer when the link has no scope.
         */
        const retainedAccess = async (
            api: AnonymousIdentityApi,
            computerId: string | null,
            signal: AbortSignal,
        ): Promise<AnonymousIdentity | null> => {
            const explicit = readIdentityScope();
            const scopes = hasIdentityScope()
                ? explicit === null
                    ? []
                    : [explicit]
                : rememberedComputers().map((computer) => computer.scope);
            const visited = new Set<string>();
            for (const scope of scopes.filter((candidate) => candidate.computerId === computerId)) {
                if (visited.has(computerKey(scope))) {
                    continue;
                }
                visited.add(computerKey(scope));
                const retained = await api.loadScope(scope, signal);
                signal.throwIfAborted();
                if (retained !== null) {
                    return retained;
                }
            }
            return null;
        };
        /**
         * Reads a sealed setup link's contents from the Relay and opens them with the key only the link holds. Once
         * they expired, the Computer opens only through access this browser still holds for it.
         */
        const unseal = async (link: SetupHandoffLink, signal: AbortSignal): Promise<void> => {
            const api = new AnonymousIdentityApi({ fetchRequest, origin: window.location.origin });
            try {
                const sealed = await api.setupHandoff(link.computerId, await setupHandoffLookupId(link), signal);
                signal.throwIfAborted();
                if (sealed === null) {
                    const retained = await retainedAccess(api, link.computerId, signal);
                    if (retained !== null) {
                        window.location.replace(identityDestination("/", retained));
                        return;
                    }
                    set({
                        state: { kind: "link-unavailable", recovery: "setup", message: "This setup link has expired." },
                    });
                    return;
                }
                const handoff = await openSetupHandoff(link, sealed);
                if (transferCodeComputer(handoff.code) !== link.computerId) {
                    throw new SetupHandoffError();
                }
                set({
                    state: {
                        kind: "session-opening",
                        code: handoff.code,
                        handoff: {
                            harness: handoff.harness,
                            sessionId: handoff.sessionId,
                            workspace: handoff.workspace,
                            encryption: { kind: "sealed", access: handoff.encryption },
                        },
                    },
                });
            } catch (cause) {
                if (signal.aborted) {
                    return;
                }
                recordBrowserError("setup-handoff", cause);
                set({
                    state:
                        cause instanceof SetupHandoffError
                            ? { kind: "link-unavailable", recovery: "setup", message: cause.message }
                            : {
                                  kind: "handoff-failed",
                                  link,
                                  message: formatError(cause, "Check your connection and try again."),
                              },
                });
                return;
            }
            await get().redeem(signal);
        };
        return {
            diagnostics: null,
            enterMorty: () => {
                const state = get().state;
                if (state.kind === "session-failed") {
                    window.location.replace(identityDestination("/", state.identity));
                }
            },
            start: () => {
                attempt?.abort(new Error("The continuation was restarted."));
                attempt = new AbortController();
                void get().redeem(attempt.signal);
            },
            cancel: () => {
                attempt?.abort(new Error("The continuation was cancelled."));
            },
            retry: () => {
                const state = get().state;
                if (
                    state.kind !== "session-failed" &&
                    state.kind !== "redeem-failed" &&
                    state.kind !== "failed" &&
                    state.kind !== "handoff-failed"
                ) {
                    return;
                }
                attempt?.abort(new Error("The transfer retry replaced this attempt."));
                attempt = new AbortController();
                if (state.kind === "session-failed") {
                    // The redeemed access, not the transfer code, owns this
                    // retry: the link may be gone while the access still works.
                    void openSession(state.handoff, state.identity, attempt.signal);
                    return;
                }
                set({
                    state:
                        state.kind === "handoff-failed"
                            ? { kind: "handoff-unsealing", link: state.link }
                            : state.kind === "failed"
                              ? { code: state.code, kind: "identity-redeeming" }
                              : {
                                    code: state.code,
                                    handoff: state.handoff,
                                    kind: "session-opening",
                                },
                });
                void get().redeem(attempt.signal);
            },
            state: initialState(),
            redeem: async (signal) => {
                const state = get().state;
                if (state.kind === "handoff-unsealing") {
                    await unseal(state.link, signal);
                    return;
                }
                if (state.kind !== "session-opening" && state.kind !== "identity-redeeming") {
                    return;
                }
                const encryption: HandoffEncryption =
                    state.kind === "session-opening" ? state.handoff.encryption : { kind: "fragment" };
                const api = new AnonymousIdentityApi({
                    fetchRequest,
                    origin: window.location.origin,
                });
                set({ diagnostics: null });
                let identity: AnonymousIdentity;
                try {
                    identity = await api.redeemTransfer(state.code, signal);
                    signal.throwIfAborted();
                    await retainEncryption(identity, encryption, signal);
                } catch (cause) {
                    if (signal.aborted) {
                        return;
                    }
                    recordBrowserError("redeem", cause);
                    const message = formatError(cause, "This transfer link is unavailable.");
                    // A dead transfer code may not be this browser's only access
                    // to its Computer. Validate only the explicit scope, or a remembered
                    // scope for this exact Computer when the old link has no scope.
                    if (cause instanceof IdentityApiError && cause.code === "TRANSFER_UNAVAILABLE") {
                        try {
                            const retained = await retainedAccess(api, transferCodeComputer(state.code), signal);
                            if (retained !== null) {
                                await retainEncryption(retained, encryption, signal);
                                if (state.kind === "identity-redeeming") {
                                    window.location.replace(redeemedDestination(retained, linkedChat));
                                } else {
                                    await openSession(state.handoff, retained, signal);
                                }
                                return;
                            }
                        } catch (retainedCause) {
                            if (signal.aborted) {
                                return;
                            }
                            recordBrowserError("load-retained-identity", retainedCause);
                            // The code is terminal, but checking independently
                            // retained access can still succeed after reconnecting.
                            showRetryableFailure(state, retainedCause);
                            return;
                        }
                        set({
                            state: {
                                kind: "link-unavailable",
                                recovery: state.kind === "session-opening" ? "setup" : "share",
                                message,
                            },
                        });
                        return;
                    }
                    showRetryableFailure(state, cause);
                    return;
                }
                if (state.kind === "identity-redeeming") {
                    window.location.replace(redeemedDestination(identity, linkedChat));
                    return;
                }
                await openSession(state.handoff, identity, signal);
            },
        };
    });
    return store;
};
