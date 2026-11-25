import { NativeSessionMap, sameNativeSession } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { encodeIdentityScope, type IdentityScope } from "../../services/identity/identity-scope-url.ts";
import { rememberComputerName, rememberComputerVisit } from "../../services/identity/remembered-computers.ts";
import { mortyReleaseVersion, mortyUpdatePrompt } from "../../services/release/morty-release.ts";
import type { Clock } from "../../services/time/clock.ts";
import type { AppInstallStoreApi } from "../app-install-store.ts";
import type { IdentityAccess } from "../authentication/identity-access.ts";
import type { BugReportDialogStore } from "../bug-report-dialog-store.ts";
import { reportApplicationError } from "../report-error.ts";
import { type AccessExpiryStore, createAccessExpiryStore } from "./access-expiry-store.ts";
import type { AccessHolder } from "./access-presentation.ts";
import { type BotChatHomeStoreApi, createBotChatHomeStore, homeWaitsForComputer } from "./bot-chat-home-store.ts";
import { createComputerFollower } from "./computer-follower.ts";
import { createComputerRecovery } from "./computer-recovery.ts";
import { type ComputerReleaseStoreApi, createComputerReleaseStore } from "./computer-release-store.ts";
import { type ComputerStatusStoreApi, createComputerStatusStore } from "./computer-status-store.ts";
import type { ComputerSwitcherModel } from "./computer-switcher-store.ts";
import { connectionPresentation } from "./connection-presentation.ts";
import {
    type ConversationDirectoryStore,
    createConversationDirectoryStore,
    type DirectoryLoadMode,
    directoryWaitsForComputer,
} from "./conversation-directory-store.ts";
import type { ConversationSelectionState } from "./conversation-selection-machine.ts";
import { selectedConversationTarget } from "./conversation-selection-machine.ts";
import {
    type ConversationStatusStoreApi,
    createConversationStatusStore,
    hasWorkingBackgroundConversation,
} from "./conversation-status-store.ts";
import { createDeviceAccessStore, type DeviceAccessStore } from "./device-access-store.ts";
import { createDraftControlsStore, type DraftControlsStore, draftConfiguration } from "./draft-controls-store.ts";
import { createLinkedDevicesStore, type LinkedDevicesStore } from "./linked-devices-store.ts";
import { createNetworkDiagnosticStore, type NetworkDiagnosticStore } from "./network-diagnostic-store.ts";
import { createRemoteAccessStore, type RemoteAccessStore } from "./remote-access-store.ts";
import { connectionWaitsForComputer } from "./session-connection.ts";
import { sessionConnectionView } from "./session-connection-machine.ts";
import { commandEnded, pageActivity, submittingCommandId } from "./session-execution.ts";
import { createSessionPageState, type SessionPageState } from "./session-page-state.ts";
import { createSessionPaneModel, type SessionPaneModel } from "./session-pane-store.ts";
import { createSessionTitlesStore, type SessionTitlesStore } from "./session-titles-store.ts";
import { createSidebarDialogs, type SidebarDialogs } from "./sidebar-dialogs.ts";

interface ChatWorkspaceSidebar {
    readonly dialogs: SidebarDialogs;
    readonly remoteAccess: StoreApi<RemoteAccessStore>;
    readonly networkDiagnostic: StoreApi<NetworkDiagnosticStore>;
}

type WorkspacePane =
    | { readonly kind: "none" }
    | { readonly kind: "open"; readonly model: ReturnType<typeof createSessionPaneModel> };

/** What views read of the pane: they follow it, and never start or stop it. */
type ChatWorkspacePane = { readonly kind: "none" } | { readonly kind: "open"; readonly model: SessionPaneModel };

export interface ChatWorkspace {
    readonly computers: ComputerSwitcherModel;
    readonly accessNotice: string | null;
    readonly linkedDevices: StoreApi<LinkedDevicesStore>;
    readonly accessExpiry: StoreApi<AccessExpiryStore>;
    readonly deviceAccess: StoreApi<DeviceAccessStore>;
    readonly requests: BotChatApi;
    /** The application-owned bug-report dialog state, flowing to entry points. */
    readonly bugReportDialog: BugReportDialogStore;
    readonly appInstall: AppInstallStoreApi;
    readonly computerId: string;
    readonly computer: ComputerStatusStoreApi;
    readonly computerRelease: ComputerReleaseStoreApi;
    readonly home: BotChatHomeStoreApi;
    readonly titles: SessionTitlesStore;
    readonly directory: StoreApi<ConversationDirectoryStore>;
    readonly statuses: ConversationStatusStoreApi;
    readonly draftControls: StoreApi<DraftControlsStore>;
    readonly sidebar: ChatWorkspaceSidebar;
    readonly pane: Pick<StoreApi<ChatWorkspacePane>, "getState" | "getInitialState" | "subscribe">;
    readonly sessionPane: () => SessionPaneModel | null;
    readonly sessionPage: (
        sessionTarget: NativeSessionTarget,
    ) => Pick<SessionPageState, "execution" | "delivery"> | null;
    readonly retryDraftControls: () => void;
    readonly refreshDirectory: () => void;
    readonly operationsSignal: () => AbortSignal;
    /** Records deliberate activity in this tab without following another tab's selection. */
    readonly recordUserActivity: () => void;
    /** Starts a new conversation whose draft asks the Agent to update Morty; the person reviews and sends it. */
    readonly draftComputerUpdate: () => void;
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
    readonly onComputerReplaced: () => void;
    readonly rememberedIdentity: IdentityScope;
    readonly computers: ComputerSwitcherModel;
    readonly accessNotice: string | null;
    readonly entry: "address" | "restore";
    readonly bugReportDialog: BugReportDialogStore;
    readonly appInstall: AppInstallStoreApi;
    readonly accessHolder: AccessHolder;
    readonly computerId: string;
    readonly requests: BotChatApi;
    readonly access: IdentityAccess;
    readonly networkDiagnostics: {
        readonly measureBrowserMorty: (signal: AbortSignal) => Promise<number>;
    };
}): ChatWorkspace {
    const computerId = options.computerId;
    const requests = options.requests;
    let rememberedSessionTarget: NativeSessionTarget | null = null;
    let initialVisitPending = true;
    const recordHome = () => {
        rememberedSessionTarget = null;
        rememberComputerVisit(options.rememberedIdentity, options.clock.now(), { kind: "home" });
    };
    const titles: SessionTitlesStore = createSessionTitlesStore(encodeIdentityScope(options.rememberedIdentity));
    const computer = createComputerStatusStore(navigator.onLine);
    const computerRelease = createComputerReleaseStore({ latest: mortyReleaseVersion, requests, clock: options.clock });
    const follower = createComputerFollower({
        requests,
        computer,
        clock: options.clock,
        draftSelected: () => home.getState().selection.kind === "draft",
        onConfiguration: (configuration, observation) => {
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
            rememberComputerName(options.rememberedIdentity, configuration.computer.computerName);
            computerRecovery.observe(configuration.computer.online, observation);
            computerRelease.getState().observe(configuration.computer.online);
        },
        onEntered: (outcome) => home.getState().entryAnswered(outcome),
        onRevoked: (message) => home.getState().computerRevoked(message),
        onReplaced: () => {
            // A Session belongs to the Computer that held it, so the page starts over on the Computer's new conversation.
            const url = new URL(window.location.href);
            url.searchParams.delete("harness");
            url.searchParams.delete("sessionId");
            window.history.replaceState(window.history.state, "", url);
            options.onComputerReplaced();
        },
        retry: () => home.getState().retry(),
        onRestart: () => startOver(),
        onWaitingForComputer: () => computerRecovery.failed(),
    });
    const home: BotChatHomeStoreApi = createBotChatHomeStore(requests, {
        computerId,
        computer,
        titles,
        draftConfiguration: () => draftConfiguration(draftControls.getState().settings),
        connectionAvailable: () =>
            connectionPresentation(computer.getState(), home.getState().selection, null).available,
        clock: options.clock,
        computerEntered: follower.entered,
        onComputerInterrupted: follower.interrupted,
        onComputerRevokedByOperation: follower.revokedByOperation,
        onWaitingForComputer: () => computerRecovery.failed(),
        createId: () => crypto.randomUUID(),
        navigation: historyNavigation(recordHome),
        entry: options.entry,
        onDraftSelected: () => enterDraft(),
        onRestart: () => startOver(),
        // A selection chosen while the Computer's entry failed starts the page over, as Reconnect would.
        onSelectionChanged: () => (computer.getState().entry.kind === "failed" ? startOver() : startHomeLoad()),
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
            const selection = home.getState().selection;
            if (selection.kind !== "draft") {
                draftControls.getState().leave();
            }
            const open = paneStore.getState();
            if (open.kind === "open" && (selection.kind !== "ready" || selection.session !== open.model.session)) {
                closePane();
            }
            if (backgroundConversationIsWorking()) {
                void startDirectoryLoad("background");
            }
        },
        url: window.location.href,
    });
    const directory = createConversationDirectoryStore(
        requests,
        (sessions, previous) => {
            statuses.getState().directoryLoaded(sessions, previous);
            void draftControls
                .getState()
                .verifySessionDirectories(sessions, operationsLifetime.signal)
                .catch(() => undefined);
        },
        options.clock,
        titles,
        (sessionTarget) => {
            // Closing changes directory membership. Replace any read started before that change in the same
            // lifecycle that owns refreshes, so its delayed answer cannot put the closed Session back.
            void startDirectoryLoad();
            const selected = selectedConversationTarget(home.getState().selection);
            if (selected === null || !sameNativeSession(selected, sessionTarget)) {
                return;
            }
            home.getState().newConversation();
        },
    );
    const statuses = createConversationStatusStore({
        selectedSessionId: () => selectedConversationTarget(home.getState().selection),
        activity: (sessionTarget) => sessionPageActivity(sessionTarget),
        endObserved: (sessionTarget, commandId) => {
            const state = sessionStates.get(sessionTarget);
            return state !== undefined && commandEnded(state.execution.getState().state, commandId);
        },
    });
    const draftControls = createDraftControlsStore(
        computerId,
        requests,
        () => computer.getState().computerConfiguration,
        () => computerRecovery.failed(),
    );
    const sidebar: ChatWorkspaceSidebar = {
        dialogs: createSidebarDialogs({
            clock: options.clock,
            signal: () => operationsLifetime.signal,
            requests,
            computer: () => computer.getState().computerConfiguration?.computer ?? null,
            shareAccess: options.access.shareAccess,
            sharingTerms: options.access.sharingTerms,
            onHomeScreenLinkCopied: () => options.appInstall.getState().dismissSuggestion(),
            accessHolder: options.accessHolder,
            onOpenSession: (session) => {
                home.getState().openManaged(session.target);
            },
            onOpenedSession: () => startDirectoryLoad(),
        }),
        remoteAccess: createRemoteAccessStore({
            currentAccessToken: options.access.currentAccessToken,
            endRemoteAccess: options.access.endRemoteAccess,
        }),
        networkDiagnostic: createNetworkDiagnosticStore({
            measureBrowserMorty: options.networkDiagnostics.measureBrowserMorty,
            measureServerHops: (signal) => requests.networkDiagnostic(signal),
        }),
    };
    let chatLifetime = new AbortController();
    chatLifetime.abort(new Error("The chat workspace has not loaded yet."));
    // The Computer's follow outlives every selection: only starting the page over restarts it.
    let computerLifetime = new AbortController();
    computerLifetime.abort(new Error("The chat workspace has not loaded yet."));
    let directoryLifetime = new AbortController();
    directoryLifetime.abort(new Error("The chat workspace has not loaded yet."));
    const operationsLifetime = new AbortController();

    const startComputerFollow = (): void => {
        computerLifetime.abort(new Error("Computer following restarted."));
        computerLifetime = new AbortController();
        const signal = computerLifetime.signal;
        void follower.follow(signal).catch((cause: unknown) => {
            if (!signal.aborted) {
                reportApplicationError(cause, "computer-follow");
            }
        });
    };
    const startOver = (): void => {
        startComputerFollow();
        startHomeLoad();
        void startDirectoryLoad();
    };
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
    const enterDraft = (): void => {
        void draftControls
            .getState()
            .enter(operationsLifetime.signal)
            .catch(() => undefined);
    };
    /** Settles once this load's first listing was read, or it ended without one; it never rejects. */
    const startDirectoryLoad = (mode: DirectoryLoadMode = "foreground"): Promise<void> => {
        directoryLifetime.abort(new Error("Directory loading restarted."));
        directoryLifetime = new AbortController();
        const signal = directoryLifetime.signal;
        const loaded = Promise.withResolvers<void>();
        void followDirectory(signal, mode, loaded.resolve)
            .catch(() => undefined)
            .finally(loaded.resolve);
        return loaded.promise;
    };
    const backgroundConversationIsWorking = (): boolean => {
        const state = directory.getState().state;
        return (
            "sessions" in state &&
            hasWorkingBackgroundConversation(
                state.sessions,
                statuses.getState().records,
                sessionPageActivity,
                selectedConversationTarget(home.getState().selection),
            )
        );
    };
    const followDirectory = async (signal: AbortSignal, mode: DirectoryLoadMode, loaded: () => void): Promise<void> => {
        do {
            const open = paneStore.getState();
            const following = [...sessionStates].flatMap(([target, state]) =>
                (open.kind === "open" && sameNativeSession(open.model.session.target, target)) ||
                submittingCommandId(state.execution.getState().state, state.delivery.getState().state) !== null
                    ? [target]
                    : [],
            );
            statuses.getState().directoryLoadStarted(following);
            await directory.getState().load(signal, mode);
            loaded();
            signal.throwIfAborted();
            if (listWaitsForComputer()) {
                computerRecovery.failed();
                return;
            }
            computerRecovery.working();
            if (!backgroundConversationIsWorking()) {
                return;
            }
            await options.clock.sleep(2_000, signal);
            mode = "background";
        } while (backgroundConversationIsWorking());
    };
    const listWaitsForComputer = (): boolean => directoryWaitsForComputer(directory.getState().state);
    const draftWaitsForComputer = (): boolean => draftControls.getState().settings.kind === "unreachable";
    const paneWaitingForComputer = () => {
        const open = paneStore.getState();
        return open.kind === "open" &&
            connectionWaitsForComputer(sessionConnectionView(open.model.connection.getState().state))
            ? open.model
            : null;
    };
    const computerRecovery = createComputerRecovery({
        clock: options.clock,
        lifetime: operationsLifetime.signal,
        waiting: () =>
            homeWaitsForComputer(home.getState(), computer.getState()) ||
            listWaitsForComputer() ||
            draftWaitsForComputer() ||
            paneWaitingForComputer() !== null,
        retry: () => {
            if (homeWaitsForComputer(home.getState(), computer.getState())) {
                home.getState().retry();
            } else if (listWaitsForComputer()) {
                void startDirectoryLoad();
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
    const paneStore = createStore<WorkspacePane>(() => ({ kind: "none" }));
    const closePane = (): void => {
        const open = paneStore.getState();
        if (open.kind === "open") {
            paneStore.setState({ kind: "none" }, true);
            open.model.stop();
        }
    };
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
            refreshDirectory: () => startDirectoryLoad(),
            forkSession: requests.forkNativeSession,
            openFork: (source, fork) => {
                // A fork that completes after the user moved on must not pull them away from where they are.
                const selected = selectedConversationTarget(home.getState().selection);
                if (selected !== null && sameNativeSession(selected, source)) {
                    home.getState().openManaged(fork);
                }
                void startDirectoryLoad();
            },
            lifetime: operationsLifetime.signal,
        });
        sessionStates.set(sessionTarget, state);
        return state;
    };
    const sessionPageActivity = (sessionTarget: NativeSessionTarget) => {
        const state = sessionStates.get(sessionTarget);
        return state === undefined
            ? null
            : pageActivity(state.execution.getState().state, state.delivery.getState().state);
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
        const sessionTarget = selection.session.target;
        if (rememberedSessionTarget === null || !sameNativeSession(rememberedSessionTarget, sessionTarget)) {
            rememberComputerVisit(options.rememberedIdentity, options.clock.now(), {
                kind: "session",
                ...selection.session.target,
            });
            rememberedSessionTarget = sessionTarget;
        }
        draftControls.getState().conversationOpened(sessionTarget.harness);
        const sessionPage = sessionState(sessionTarget);
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
            titles,
            connectionAvailable: (connection) =>
                connectionPresentation(computer.getState(), home.getState().selection, connection).available,
            onConnected: () => computerRecovery.working(),
            onWaitingForComputer: () => computerRecovery.failed(),
        });
        paneStore.setState({ kind: "open", model }, true);
        model.start();
        statuses.getState().followed(sessionTarget);
    };

    const linkedDevices = createLinkedDevicesStore({
        computerId: options.computerId,
        linkedDevices: options.access.linkedDevices,
        waitForChange: options.access.waitForLinkedDevicesChange,
        clock: options.clock,
    });
    const accessExpiry = createAccessExpiryStore({
        computerId: options.computerId,
        accessExpiresAt: options.access.accessExpiresAt,
        clock: options.clock,
        holder: options.accessHolder,
    });
    return {
        computers: options.computers,
        computerRelease,
        accessNotice: options.accessNotice,
        linkedDevices,
        accessExpiry,
        deviceAccess: createDeviceAccessStore({
            endDeviceAccess: options.access.endDeviceAccess,
            endOtherBrowserAccess: options.access.endOtherBrowserAccess,
            readDevices: linkedDevices.getState().refresh,
        }),
        draftComputerUpdate: () => {
            home.getState().newConversation();
            home.getState().setDraft(mortyUpdatePrompt);
        },
        recordUserActivity: () => {
            const selection = home.getState().selection;
            const destination =
                selection.kind === "ready"
                    ? {
                          kind: "session" as const,
                          ...selection.session.target,
                      }
                    : selection.kind === "draft"
                      ? { kind: "home" as const }
                      : undefined;
            rememberComputerVisit(options.rememberedIdentity, options.clock.now(), destination);
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
            void options.computers.refresh();
            if (home.getState().selection.kind === "draft") {
                enterDraft();
            }
            startOver();
        },
        requests,
        computerId,
        bugReportDialog: options.bugReportDialog,
        appInstall: options.appInstall,
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
        sessionPage: (sessionTarget) => sessionStates.get(sessionTarget) ?? null,
        retryDraftControls: () => {
            void draftControls
                .getState()
                .retry(operationsLifetime.signal)
                .catch(() => undefined);
        },
        refreshDirectory: startDirectoryLoad,
        operationsSignal: () => operationsLifetime.signal,
        dispose: () => {
            options.computers.dispose();
            computerRelease.getState().dispose();
            sidebar.dialogs.getState().discardNativeDialog();
            sidebar.dialogs.getState().closeSharing();
            home.getState().composerAttachments.getState().clear();
            for (const state of sessionStates.values()) {
                state.composer.getState().attachments.getState().clear();
            }
            closePane();
            computerLifetime.abort(new Error("The chat workspace was disposed."));
            chatLifetime.abort(new Error("The chat workspace was disposed."));
            directoryLifetime.abort(new Error("The chat workspace was disposed."));
            operationsLifetime.abort(new Error("The chat workspace was disposed."));
            sessionStates.clear();
        },
    };
}
