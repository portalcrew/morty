import { NativeSessionMap, sameNativeSession } from "@morty-build/client/native-session";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import type { IdentityTransfer, LinkedDevice, SharingTerms } from "../../services/identity/anonymous-identity-api.ts";
import { encodeIdentityScope, type IdentityScope } from "../../services/identity/identity-scope-url.ts";
import { rememberComputerName, rememberComputerVisit } from "../../services/identity/remembered-computers.ts";
import type { Clock } from "../../services/time/clock.ts";
import type { BugReportDialogStore } from "../bug-report-dialog-store.ts";
import { reportApplicationError } from "../report-error.ts";
import { type AccessExpiryStore, createAccessExpiryStore } from "./access-expiry-store.ts";
import { type BotChatHomeStoreApi, createBotChatHomeStore, homeWaitsForComputer } from "./bot-chat-home-store.ts";
import { createComputerRecovery } from "./computer-recovery.ts";
import { type ComputerStatusStoreApi, createComputerStatusStore } from "./computer-status-store.ts";
import type { ComputerSwitcherModel } from "./computer-switcher-store.ts";
import { connectionPresentation } from "./connection-presentation.ts";
import { type ConversationDirectoryStore, createConversationDirectoryStore } from "./conversation-directory-store.ts";
import type { ConversationSelectionState } from "./conversation-selection-machine.ts";
import { selectedConversationTarget } from "./conversation-selection-machine.ts";
import { type ConversationStatusStoreApi, createConversationStatusStore } from "./conversation-status-store.ts";
import { createDeviceAccessStore, type DeviceAccessStore } from "./device-access-store.ts";
import { createDraftControlsStore, type DraftControlsStore, draftConfiguration } from "./draft-controls-store.ts";
import { createLinkedDevicesStore, type LinkedDevicesStore } from "./linked-devices-store.ts";
import { createNetworkDiagnosticStore, type NetworkDiagnosticStore } from "./network-diagnostic-store.ts";
import { createRemoteAccessStore, type RemoteAccessStore } from "./remote-access-store.ts";
import { connectionWaitsForComputer } from "./session-connection.ts";
import { createSessionPageState, type SessionPageState } from "./session-page-state.ts";
import { createSessionPaneModel, type SessionPaneModel } from "./session-pane-store.ts";
import { createSessionTitlesStore, type SessionTitlesStore } from "./session-titles-store.ts";
import { createSidebarDialogs, type SidebarDialogs } from "./sidebar-dialogs.ts";

interface ChatWorkspaceSidebar {
    readonly dialogs: SidebarDialogs;
    readonly remoteAccess: StoreApi<RemoteAccessStore>;
    readonly networkDiagnostic: StoreApi<NetworkDiagnosticStore>;
}

/**
 * The Session pane the workspace keeps. It exists while its session record is the ready selection: another target
 * closes it, a re-read replaces it, and the workspace tears it down.
 */
type WorkspacePane =
    | { readonly kind: "none" }
    | { readonly kind: "open"; readonly model: ReturnType<typeof createSessionPaneModel> };

/** What views read of the pane: they follow it, and never start or stop it. */
type ChatWorkspacePane = { readonly kind: "none" } | { readonly kind: "open"; readonly model: SessionPaneModel };

export interface ChatWorkspace {
    readonly computers: ComputerSwitcherModel | null;
    readonly accessNotice: string | null;
    /** The page's one list of the other devices with access, and when this browser last looked at it. */
    readonly linkedDevices: StoreApi<LinkedDevicesStore> | null;
    /** When this browser's access ends; null when the page cannot read its own access. */
    readonly accessExpiry: StoreApi<AccessExpiryStore> | null;
    /** The devices with access to this computer and the disconnections made from them; null when this page cannot. */
    readonly deviceAccess: StoreApi<DeviceAccessStore> | null;
    /** The chat API this workspace was composed with. */
    readonly requests: BotChatApi;
    /** The application-owned bug-report dialog state, flowing to entry points. */
    readonly bugReportDialog: BugReportDialogStore;
    /** The authenticated computer; scopes browser persistence and diagnostics. */
    readonly computerId: string;
    /** What the page knows of its Computer: pairing, its configuration, and the network. */
    readonly computer: ComputerStatusStoreApi;
    readonly home: BotChatHomeStoreApi;
    readonly titles: SessionTitlesStore;
    readonly directory: StoreApi<ConversationDirectoryStore>;
    readonly statuses: ConversationStatusStoreApi;
    /** Harness and working-directory settings for the next draft message. */
    readonly draftControls: StoreApi<DraftControlsStore>;
    /** Sidebar ephemeral UI and dialog stores; lives outside React with this workspace. */
    readonly sidebar: ChatWorkspaceSidebar;
    /**
     * The session pane of the currently selected conversation, built and started by the workspace in the transition
     * that makes the selection ready for a fresh session record, and stopped when it moves on. Views subscribe to it.
     */
    readonly pane: Pick<StoreApi<ChatWorkspacePane>, "getState" | "getInitialState" | "subscribe">;
    /** The open pane's model, for callers outside React. */
    readonly sessionPane: () => SessionPaneModel | null;
    /** Restarts the draft settings load, for example from its retry control. */
    readonly retryDraftControls: () => void;
    /** Restarts the directory load, for example from the sidebar refresh button. */
    readonly refreshDirectory: () => void;
    /** Reports a session activity change from an open session pane. */
    /** The signal of the current home loading attempt; aborted when loading restarts. */
    readonly chatSignal: () => AbortSignal;
    /** A stable signal for user-triggered operations such as archiving and diagnostics. */
    readonly operationsSignal: () => AbortSignal;
    /** Records deliberate activity in this tab without following another tab's selection. */
    readonly recordUserActivity: () => void;
    /** Starts the workspace's loads; the application calls this when it activates the workspace. */
    readonly start: () => void;
    readonly dispose: () => void;
}

function historyNavigation(onDraft: () => void) {
    const replace = (modify: (url: URL) => void): void => {
        const url = new URL(window.location.href);
        modify(url);
        window.history.replaceState(window.history.state, "", url);
    };
    return {
        showDraft: () => {
            onDraft();
            replace((url) => {
                url.searchParams.delete("harness");
                url.searchParams.delete("sessionId");
            });
        },
        showManaged: (target: NativeSessionTarget) =>
            replace((url) => {
                url.searchParams.set("harness", target.harness);
                url.searchParams.set("sessionId", target.sessionId);
            }),
    };
}

/**
 * Composes the chat screen's collaborating stores — home selection, the
 * conversation directory, and conversation statuses — and owns their loading
 * lifetimes outside React. The home store announces restarts and pane replacements
 * through explicit port callbacks, so a restart cancels the previous attempt
 * without any component effect.
 */
export function createChatWorkspace(options: {
    readonly clock: Clock;
    /** Starts the page over once its Computer is paired again after revocation; see the home store's announcement. */
    readonly onComputerReplaced: () => void;
    readonly rememberedIdentity?: IdentityScope;
    readonly computers?: ComputerSwitcherModel;
    readonly accessNotice?: string | null;
    readonly entry?: "address" | "restore";
    readonly bugReportDialog: BugReportDialogStore;
    readonly computerId: string;
    readonly requests: BotChatApi;
    readonly createTransfer?: ((terms: SharingTerms, signal: AbortSignal) => Promise<IdentityTransfer>) | undefined;
    readonly currentAccessToken?: ((signal: AbortSignal) => Promise<string>) | undefined;
    readonly endRemoteAccess?: ((signal: AbortSignal) => Promise<void>) | undefined;
    readonly accessExpiresAt?: ((signal: AbortSignal) => Promise<string | null>) | undefined;
    readonly linkedDevices?: ((signal: AbortSignal) => Promise<readonly LinkedDevice[]>) | undefined;
    readonly waitForLinkedDevicesChange?: ((signal: AbortSignal) => Promise<void>) | undefined;
    readonly endOtherBrowserAccess?: ((signal: AbortSignal) => Promise<void>) | undefined;
    readonly endDeviceAccess?: ((deviceId: string, signal: AbortSignal) => Promise<void>) | undefined;
    readonly networkDiagnostics?: {
        readonly measureBrowserMorty: (signal: AbortSignal) => Promise<number>;
    };
}): ChatWorkspace {
    const computerId = options.computerId;
    const requests = options.requests;
    let rememberedSessionTarget: NativeSessionTarget | null = null;
    let initialVisitPending = true;
    const recordHome = () => {
        rememberedSessionTarget = null;
        if (options.rememberedIdentity !== undefined) {
            rememberComputerVisit(options.rememberedIdentity, options.clock.now(), { kind: "home" });
        }
    };
    const titles: SessionTitlesStore = createSessionTitlesStore(
        options.rememberedIdentity === undefined ? null : encodeIdentityScope(options.rememberedIdentity),
    );
    const computer = createComputerStatusStore(navigator.onLine);
    const home: BotChatHomeStoreApi = createBotChatHomeStore(requests, {
        computerId,
        computer,
        titles,
        draftConfiguration: () => draftConfiguration(draftControls.getState().settings),
        connectionAvailable: () =>
            connectionPresentation(computer.getState(), home.getState().selection, null).available,
        clock: options.clock,
        onWaitingForComputer: () => computerRecovery.failed(),
        createId: () => crypto.randomUUID(),
        navigation: historyNavigation(recordHome),
        entry: options.entry ?? "address",
        onComputerConfiguration: (configuration, observation) => {
            sidebar.dialogs.getState().computerChanged();
            void draftControls
                .getState()
                .computerChanged(configuration, operationsLifetime.signal)
                .catch(() => undefined);
            if (initialVisitPending) {
                initialVisitPending = false;
                if (home.getState().selection.kind === "draft") {
                    recordHome();
                }
            }
            if (options.rememberedIdentity !== undefined) {
                rememberComputerName(options.rememberedIdentity, configuration.computer.computerName);
            }
            computerRecovery.observe(configuration.computer.online, observation);
        },
        onDraftSelected: () => enterDraft(),
        onRestart: () => {
            startHomeLoad();
            startDirectoryLoad();
        },
        onSelectionChanged: () => startHomeLoad(),
        onComputerReplaced: () => {
            // A Session belongs to the Computer that held it, so the page starts over on the Computer's new conversation.
            const url = new URL(window.location.href);
            url.searchParams.delete("harness");
            url.searchParams.delete("sessionId");
            window.history.replaceState(window.history.state, "", url);
            options.onComputerReplaced();
        },
        onDirectoryRefreshed: () => startDirectoryLoad(),
        onFirstMessage: (sessionTarget, message) =>
            sessionState(sessionTarget).delivery.getState().awaitConnection(message),
        onSelectionReady: (selection) => {
            computerRecovery.working();
            replacePane(selection);
        },
        onSelectionTargeted: (conversationId) => {
            if (conversationId !== null) {
                statuses.getState().opened(conversationId);
            }
            // A pane lives while its session record is the ready selection; any other target ends it. The draft's
            // settings live while the draft is selected.
            const selection = home.getState().selection;
            if (selection.kind !== "draft") {
                draftControls.getState().leave();
            }
            const open = paneStore.getState();
            if (open.kind === "open" && (selection.kind !== "ready" || selection.session !== open.model.session)) {
                closePane();
            }
        },
        url: window.location.href,
    });
    const directory = createConversationDirectoryStore(
        requests,
        (sessions) => {
            statuses.getState().directoryLoaded(sessions);
        },
        options.clock,
        titles,
        (sessionTarget) => {
            // Closing changes directory membership. Replace any read started before that change in the same
            // lifecycle that owns refreshes, so its delayed answer cannot put the closed Session back.
            startDirectoryLoad();
            const selected = selectedConversationTarget(home.getState().selection);
            if (selected === null || !sameNativeSession(selected, sessionTarget)) {
                return;
            }
            home.getState().newConversation();
        },
    );
    const statuses = createConversationStatusStore(() => selectedConversationTarget(home.getState().selection));
    const draftControls = createDraftControlsStore(
        computerId,
        requests,
        () => computer.getState().computerConfiguration,
        () => computerRecovery.failed(),
    );
    // Sidebar stores live with the workspace, outside React: dialogs (native
    // session import, identity sharing, expanded state), remote access, and
    // network diagnostics all outlive any single sidebar render.
    const sidebar: ChatWorkspaceSidebar = {
        dialogs: createSidebarDialogs({
            clock: options.clock,
            signal: () => operationsLifetime.signal,
            requests,
            computer: () => computer.getState().computerConfiguration?.computer ?? null,
            createTransfer: (terms, signal) => {
                if (options.createTransfer === undefined) {
                    return Promise.reject(new Error("Identity sharing is unavailable."));
                }
                return options.createTransfer(terms, signal);
            },
            onOpenSession: (session) => {
                home.getState().openManaged({
                    harness: session.result.ready.harness,
                    sessionId: session.entry.sessionId,
                });
            },
            onOpenedSession: () => startDirectoryLoad(),
        }),
        remoteAccess: createRemoteAccessStore({
            currentAccessToken: (signal) => {
                if (options.currentAccessToken === undefined) {
                    return Promise.reject(new Error("Remote access is unavailable."));
                }
                return options.currentAccessToken(signal);
            },
            endRemoteAccess: (signal) => {
                if (options.endRemoteAccess === undefined) {
                    return Promise.reject(new Error("Remote access is unavailable."));
                }
                return options.endRemoteAccess(signal);
            },
        }),
        networkDiagnostic: createNetworkDiagnosticStore({
            measureBrowserMorty: (signal) => {
                if (options.networkDiagnostics === undefined) {
                    return Promise.reject(new Error("Network diagnostics are unavailable."));
                }
                return options.networkDiagnostics.measureBrowserMorty(signal);
            },
            measureServerHops: (signal) => requests.networkDiagnostic(signal),
        }),
    };
    let chatLifetime = new AbortController();
    chatLifetime.abort(new Error("The chat workspace has not loaded yet."));
    let directoryLifetime = new AbortController();
    directoryLifetime.abort(new Error("The chat workspace has not loaded yet."));
    const operationsLifetime = new AbortController();

    const startHomeLoad = (): void => {
        chatLifetime.abort(new Error("Chat loading restarted."));
        chatLifetime = new AbortController();
        const signal = chatLifetime.signal;
        void home
            .getState()
            .load(signal)
            .catch((cause: unknown) => {
                if (!signal.aborted) {
                    reportApplicationError(cause, "chat-home-load");
                }
            });
    };
    /** The draft composer's settings live while a draft is selected, independently of how the page loads. */
    const enterDraft = (): void => {
        void draftControls
            .getState()
            .enter(operationsLifetime.signal)
            .catch(() => undefined);
    };
    const startDirectoryLoad = (): void => {
        directoryLifetime.abort(new Error("Directory loading restarted."));
        directoryLifetime = new AbortController();
        const signal = directoryLifetime.signal;
        statuses.getState().directoryLoadStarted();
        void directory
            .getState()
            .load(signal)
            .catch(() => undefined)
            .finally(() => {
                if (signal.aborted) {
                    return;
                }
                if (listWaitsForComputer()) {
                    computerRecovery.failed();
                } else {
                    computerRecovery.working();
                }
            });
    };
    const listWaitsForComputer = (): boolean => {
        const listed = directory.getState().state.kind;
        return listed === "failed" || listed === "stale";
    };
    const draftWaitsForComputer = (): boolean => draftControls.getState().settings.kind === "unreachable";
    /** The live pane, when its connection used up its automatic retries and waits for the Computer. */
    const paneWaitingForComputer = () => {
        const open = paneStore.getState();
        return open.kind === "open" && connectionWaitsForComputer(open.model.store.getState().connection)
            ? open.model
            : null;
    };
    /** Retry pending reads once the computer is reachable again. */
    const computerRecovery = createComputerRecovery({
        clock: options.clock,
        lifetime: operationsLifetime.signal,
        waiting: () =>
            homeWaitsForComputer(home.getState()) ||
            listWaitsForComputer() ||
            draftWaitsForComputer() ||
            paneWaitingForComputer() !== null,
        retry: () => {
            if (homeWaitsForComputer(home.getState())) {
                home.getState().retry();
            } else if (listWaitsForComputer()) {
                startDirectoryLoad();
            }
            // A late offline response can arrive after the online watch snapshot.
            // Draft settings need the same bounded recovery as the list and statuses.
            if (draftWaitsForComputer()) {
                void draftControls
                    .getState()
                    .retry(operationsLifetime.signal)
                    .catch(() => undefined);
            }
            paneWaitingForComputer()?.reconnect();
        },
    });
    // The single live pane. It lives while its session record is the ready selection: another target closes it, a
    // re-read replaces it, and the workspace tears it down.
    const paneStore = createStore<WorkspacePane>(() => ({ kind: "none" }));
    const closePane = (): void => {
        const open = paneStore.getState();
        if (open.kind === "open") {
            paneStore.setState({ kind: "none" }, true);
            open.model.stop();
        }
    };
    // What the page holds for each Session, independently of pane and connection replacements.
    const sessionStates = new NativeSessionMap<SessionPageState>();
    const sessionState = (sessionTarget: NativeSessionTarget): SessionPageState => {
        const existing = sessionStates.get(sessionTarget);
        if (existing !== undefined) {
            return existing;
        }
        const state = createSessionPageState({
            computerId,
            sessionTarget,
            clock: options.clock,
            refreshTitle: async (signal) => {
                // Acknowledgements identify an operation, not the current title. Newer observations still win.
                const startedWith = titles.getState().titles;
                const sessions = await requests.managedSessions(signal);
                signal.throwIfAborted();
                titles.getState().directoryLoaded(sessions, startedWith);
            },
            lifetime: operationsLifetime.signal,
        });
        sessionStates.set(sessionTarget, state);
        return state;
    };
    const replacePane = (selection: Extract<ConversationSelectionState, { readonly kind: "ready" }>): void => {
        const open = paneStore.getState();
        if (open.kind === "open" && open.model.session === selection.session) {
            return;
        }
        // Keyed by the session record, not its id: every ready selection
        // arrives as a fresh record (a re-read for a reopened conversation, a
        // creation result for a new one), so the pane starts from a pristine
        // projection with its older-history pagination instead of whatever
        // the previous pane accumulated.
        closePane();
        const sessionTarget = selection.session.result.ready.target;
        if (
            options.rememberedIdentity !== undefined &&
            (rememberedSessionTarget === null || !sameNativeSession(rememberedSessionTarget, sessionTarget))
        ) {
            rememberComputerVisit(
                options.rememberedIdentity,
                options.clock.now(),
                {
                    kind: "session",
                    harness: selection.session.result.ready.harness,
                    sessionId: selection.session.entry.sessionId,
                },
                selection.session.result.ready.directoryLabel,
            );
            rememberedSessionTarget = sessionTarget;
        }
        const sessionPage = sessionState(sessionTarget);
        // Only the draft page that followed its first message here hands over the draft written meanwhile.
        const handoff = home.getState().takeNextDraft(sessionTarget);
        if (handoff !== null) {
            sessionPage.composer.getState().adoptHandoff(handoff.draft, handoff.attachments);
        }
        const model = createSessionPaneModel({
            clock: options.clock,
            session: selection.session,
            sessionPage,
            attachmentSignal: operationsLifetime.signal,
            computerId,
            requests,
            onReleased: (activity) => statuses.getState().paneReleased(sessionTarget, activity),
            titles,
            connectionAvailable: (connection) =>
                connectionPresentation(computer.getState(), home.getState().selection, connection).available,
            onConnected: () => computerRecovery.working(),
            onWaitingForComputer: () => computerRecovery.failed(),
        });
        paneStore.setState({ kind: "open", model }, true);
        model.start();
    };

    const linkedDevices =
        options.linkedDevices === undefined || options.waitForLinkedDevicesChange === undefined
            ? null
            : createLinkedDevicesStore({
                  computerId: options.computerId,
                  linkedDevices: options.linkedDevices,
                  waitForChange: options.waitForLinkedDevicesChange,
              });
    const endOtherBrowserAccess = options.endOtherBrowserAccess;
    const endDeviceAccess = options.endDeviceAccess;
    const accessExpiry =
        options.accessExpiresAt === undefined
            ? null
            : createAccessExpiryStore({
                  computerId: options.computerId,
                  accessExpiresAt: options.accessExpiresAt,
                  clock: options.clock,
              });
    return {
        computers: options.computers ?? null,
        accessNotice: options.accessNotice ?? null,
        linkedDevices,
        accessExpiry,
        deviceAccess:
            endOtherBrowserAccess === undefined || endDeviceAccess === undefined || linkedDevices === null
                ? null
                : createDeviceAccessStore({
                      endDeviceAccess,
                      endOtherBrowserAccess,
                      readDevices: linkedDevices.getState().refresh,
                  }),
        recordUserActivity: () => {
            if (options.rememberedIdentity !== undefined) {
                const selection = home.getState().selection;
                const destination =
                    selection.kind === "ready"
                        ? {
                              kind: "session" as const,
                              harness: selection.session.result.ready.harness,
                              sessionId: selection.session.entry.sessionId,
                          }
                        : selection.kind === "draft"
                          ? { kind: "home" as const }
                          : undefined;
                rememberComputerVisit(
                    options.rememberedIdentity,
                    options.clock.now(),
                    destination,
                    selection.kind === "ready" ? selection.session.result.ready.directoryLabel : undefined,
                );
            }
        },
        start: () => {
            void directory
                .getState()
                .followCalendar(operationsLifetime.signal)
                .catch((cause: unknown) => {
                    if (!operationsLifetime.signal.aborted) {
                        reportApplicationError(cause, "conversation-calendar");
                    }
                });
            void options.computers?.refresh();
            if (home.getState().selection.kind === "draft") {
                enterDraft();
            }
            startHomeLoad();
            startDirectoryLoad();
        },
        requests,
        computerId,
        bugReportDialog: options.bugReportDialog,
        directory,
        computer,
        home,
        titles,
        statuses,
        draftControls,
        sidebar,
        pane: paneStore,
        sessionPane: () => {
            const open = paneStore.getState();
            return open.kind === "open" ? open.model : null;
        },
        retryDraftControls: () => {
            void draftControls
                .getState()
                .retry(operationsLifetime.signal)
                .catch(() => undefined);
        },
        refreshDirectory: startDirectoryLoad,
        chatSignal: () => chatLifetime.signal,
        operationsSignal: () => operationsLifetime.signal,
        dispose: () => {
            options.computers?.dispose();
            sidebar.dialogs.getState().discardNativeDialog();
            sidebar.dialogs.getState().closeSharing();
            home.getState().composerAttachments.getState().clear();
            for (const state of sessionStates.values()) {
                state.composer.getState().attachments.getState().clear();
            }
            closePane();
            chatLifetime.abort(new Error("The chat workspace was disposed."));
            directoryLifetime.abort(new Error("The chat workspace was disposed."));
            operationsLifetime.abort(new Error("The chat workspace was disposed."));
            sessionStates.clear();
        },
    };
}
