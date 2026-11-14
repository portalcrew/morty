import { createStore } from "zustand/vanilla";
import type { ApiTransport } from "../services/api/api-transport.ts";
import { BotChatApi } from "../services/chat/bot-chat-api.ts";
import { browserSetupHandoff, type SetupHandoff } from "../services/device/setup-handoff.ts";
import { recordBrowserDiagnostic } from "../services/diagnostics/browser-diagnostics.ts";
import { ANONYMOUS_CREDENTIAL_KEY_NAME } from "../services/identity/anonymous-identity-api.ts";
import { replacedToken, storedToken } from "../services/identity/remembered-computers.ts";
import { type Clock, systemClock } from "../services/time/clock.ts";
import { type ActiveAnonymousSession, createAnonymousSessionStore } from "./authentication/anonymous-session-store.ts";
import { createContinueStore } from "./authentication/continue-store.ts";
import { createIdentityAccess } from "./authentication/identity-access.ts";
import { createBugReportDialogStore } from "./bug-report-dialog-store.ts";
import { type ChatWorkspace, createChatWorkspace } from "./chat/chat-workspace.ts";
import { createComputerSwitcher } from "./chat/computer-switcher-store.ts";
import { createRemoteImageConsentStore } from "./chat/remote-image-consent-store.ts";
import { type SetupHandoffModel, setupHandoffModel } from "./send-link-store.ts";

/**
 * The scope fields that identify the Bot a chat workspace talks to. The token
 * is read lazily per request, so it is not part of the identity of an
 * instance.
 */
interface ChatIdentity {
    readonly computerId: string;
    readonly getToken: (signal: AbortSignal) => Promise<string>;
}

/**
 * The signed-in chat surface, derived from the anonymous session: `active`
 * carries the workspace built for that identity, every other session state
 * carries none. Views subscribe; they never create or release a workspace.
 */
type SessionWorkspaceStoreApi = ReturnType<typeof createSessionWorkspaceStore>;

const createSessionWorkspaceStore = () => createStore<{ workspace: ChatWorkspace | null }>(() => ({ workspace: null }));

export interface MortyApplication {
    /** How this device moves setup to the computer where the agent runs. */
    readonly setupHandoff: SetupHandoffModel;
    readonly anonymousSession: ReturnType<typeof createAnonymousSessionStore>;
    /** The shared bug-report dialog state for every bug-report entry point. */
    readonly bugReportDialog: ReturnType<typeof createBugReportDialogStore>;
    /** The images on other sites the user asked to load while the page is open. */
    readonly remoteImages: ReturnType<typeof createRemoteImageConsentStore>;
    /**
     * The /continue handoff redeem. Created with the application: its store
     * reads the transfer code from the location at creation, and only a real
     * continuation visit starts network work. Another code in the address
     * reloads the page, so the store always describes the link in it.
     */
    readonly continuation: ReturnType<typeof createContinueStore>;
    /** The signed-in surface; carries the workspace for the active identity. */
    readonly sessionWorkspace: SessionWorkspaceStoreApi;
    readonly reloadIdentity: () => void;
    readonly dispose: () => void;
}

/**
 * Owns every application-scoped workflow resource outside React's mount and
 * unmount cycle: the Chat API transport, the anonymous identity session, the
 * shared bug-report dialog, the /continue redeem, and the chat workspace
 * constructed for the active identity. The anonymous identity load starts
 * here with the application lifetime, so no component needs a mount effect
 * to start it, and `dispose` releases everything at once.
 *
 * The workspace lifecycle follows the anonymous session: it is created when
 * the session becomes active for an identity and released when the session
 * leaves it or the application is disposed. Views subscribe to
 * `sessionWorkspace` and render whatever it carries.
 */
export function createMortyApplication(options: {
    readonly origin: string;
    readonly transport: ApiTransport;
    readonly clock?: Clock;
    readonly setupHandoff?: SetupHandoff;
}): MortyApplication {
    const lifetime = new AbortController();
    const transport = options.transport;
    const anonymousSession = createAnonymousSessionStore(
        transport.fetch,
        options.origin,
        (session) => {
            // Announced from the session's explicit transitions: the workspace
            // follows the identity without the application subscribing to the
            // session store.
            releaseWorkspace();
            if (session === null) {
                sessionWorkspace.setState({ workspace: null });
                return;
            }
            activateWorkspace(session);
        },
        options.clock ?? systemClock,
    );
    const bugReportDialog = createBugReportDialogStore(() => (disposed ? null : transport));
    const setupHandoff = setupHandoffModel(options.setupHandoff ?? browserSetupHandoff());
    const sessionWorkspace = createSessionWorkspaceStore();
    const continuation = createContinueStore(transport);
    let workspace: ChatWorkspace | null = null;
    let workspaceRequests: BotChatApi | null = null;
    let disposed = false;
    const releaseWorkspace = (): void => {
        workspace?.dispose();
        // Closing the injected chat API releases its Session clients, not the
        // Computer connection owned by the application transport.
        workspaceRequests?.close();
        workspace = null;
        workspaceRequests = null;
    };
    // The anonymous session owns the page's access: every check of it, and every request refused with it, goes there.
    const currentAccess = (signal: AbortSignal) => anonymousSession.getState().currentAccess(signal);
    const credentialRejected = () => anonymousSession.getState().credentialRejected(lifetime.signal);
    const activateWorkspace = (session: ActiveAnonymousSession): void => {
        const identity = session.identity;
        const scope: ChatIdentity = {
            computerId: identity.computerId,
            getToken: async (signal) => {
                signal.throwIfAborted();
                return storedToken(identity.computerId) ?? identity.computerToken;
            },
        };
        const access = createIdentityAccess({
            fetchRequest: transport.fetch,
            waitForChange: transport.waitForChange,
            origin: options.origin,
            identity: scope,
            onAccessEnded: () => window.location.reload(),
            currentAccess,
            credentialRejected,
        });
        const requests = new BotChatApi({
            fetchRequest: transport.fetch,
            sessionTransport: () => transport.computerTransport(identity.computerId),
            getToken: scope.getToken,
            replacedToken: (rejected, signal) => replacedToken(identity.computerId, rejected, signal),
            credentialRejected: () => void credentialRejected(),
            origin: options.origin,
            computerId: identity.computerId,
            waitForChange: transport.waitForChange,
        });
        workspace = createChatWorkspace({
            clock: options.clock ?? systemClock,
            onComputerReplaced: () => window.location.reload(),
            rememberedIdentity: identity,
            accessNotice: session.notice,
            computers: createComputerSwitcher({
                active: identity,
                origin: options.origin,
                fetchRequest: transport.fetch,
                requests: (saved) =>
                    new BotChatApi({
                        fetchRequest: transport.fetch,
                        sessionTransport: () => transport.computerTransport(saved.computerId),
                        getToken: async (signal) => {
                            signal.throwIfAborted();
                            return storedToken(saved.computerId) ?? saved.computerToken;
                        },
                        origin: options.origin,
                        computerId: saved.computerId,
                        waitForChange: transport.waitForChange,
                    }),
            }),
            entry: session.entry,
            bugReportDialog,
            computerId: identity.computerId,
            requests,
            access,
            networkDiagnostics: {
                measureBrowserMorty: transport.measureMortyLatency,
            },
        });
        workspaceRequests = requests;
        workspace.start();
        sessionWorkspace.setState({ workspace });
    };
    let identityAttempt: AbortController | null = null;
    const reloadIdentity = () => {
        if (disposed) {
            return;
        }
        identityAttempt?.abort(new DOMException("Identity reload replaced", "AbortError"));
        identityAttempt = new AbortController();
        const fromFailedRetry = anonymousSession.getState().state.kind === "failed";
        void anonymousSession
            .getState()
            .load(AbortSignal.any([lifetime.signal, identityAttempt.signal]), { fromFailedRetry });
    };
    // Browser lifecycle signals are hints: probe real connections and let the
    // existing session reconciliation restore history, execution and approvals.
    let recovery: Promise<void> | null = null;
    const recover = (event: Event): void => {
        if (disposed) {
            return;
        }
        recordBrowserDiagnostic({
            at: new Date().toISOString(),
            component: "web",
            operation: `page-${event.type}`,
            outcome: document.visibilityState,
            requestId: "",
            elapsedMs: 0,
        });
        if (document.visibilityState === "hidden" || recovery !== null) {
            return;
        }
        recovery = Promise.allSettled([workspace?.sessionPane()?.store.getState().recover(lifetime.signal)])
            .then(() => undefined)
            .finally(() => {
                recovery = null;
            });
    };
    const restored = (event: PageTransitionEvent): void => {
        if (event.persisted) {
            recover(event);
        }
    };
    // A continuation link carries its code after "#", and the continuation reads it when the page starts. Opening
    // another link that differs only there keeps the page, so it starts again for the link now in the address.
    const linkChanged = (): void => {
        if (window.location.pathname.startsWith("/continue")) {
            window.location.reload();
        }
    };
    // Another tab ended this browser's access, or opened a link that replaced it. Every tab uses the stored access,
    // so a replacement for the same user needs nothing; access that is gone ends here too.
    const accessChanged = (event: StorageEvent): void => {
        if (event.key !== null && event.key !== ANONYMOUS_CREDENTIAL_KEY_NAME) {
            return;
        }
        anonymousSession.getState().storedAccessRemoved();
    };
    const networkChanged = (): void => {
        workspace?.computer.getState().networkChanged(navigator.onLine);
    };
    window.addEventListener("offline", networkChanged);
    window.addEventListener("online", networkChanged);
    window.addEventListener("online", recover);
    window.addEventListener("pageshow", restored);
    window.addEventListener("hashchange", linkChanged);
    window.addEventListener("storage", accessChanged);
    document.addEventListener("visibilitychange", recover);
    document.addEventListener("resume", recover);
    if (!window.location.pathname.startsWith("/continue")) {
        reloadIdentity();
    }
    return {
        setupHandoff,
        anonymousSession,
        bugReportDialog,
        remoteImages: createRemoteImageConsentStore(),
        continuation,
        sessionWorkspace,
        reloadIdentity,
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            window.removeEventListener("offline", networkChanged);
            window.removeEventListener("online", networkChanged);
            window.removeEventListener("online", recover);
            window.removeEventListener("pageshow", restored);
            window.removeEventListener("hashchange", linkChanged);
            window.removeEventListener("storage", accessChanged);
            document.removeEventListener("visibilitychange", recover);
            document.removeEventListener("resume", recover);
            lifetime.abort(new DOMException("The Morty application was disposed.", "AbortError"));
            continuation.getState().cancel();
            if (setupHandoff.kind === "share") {
                setupHandoff.sendLink.getState().close();
            }
            releaseWorkspace();
            sessionWorkspace.setState({ workspace: null });
            transport.dispose();
        },
    };
}
