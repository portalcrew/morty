import { sameNativeSession } from "@morty-build/client/native-session";
import { type NativeSessionTarget, readNativeSessionTarget } from "@morty-build/client/protocol";
import { createStore } from "zustand/vanilla";
import { isApiConnectionError } from "../../services/api/worker-api-transport.ts";
import {
    type BotChatApi,
    type ChatAccess,
    type ChatDraftConfiguration,
    computerAgentAvailability,
} from "../../services/chat/bot-chat-api.ts";
import { CloudApiError, isComputerConnectionFailure } from "../../services/management/management-api.ts";
import {
    centralSessionStorage,
    newConversationDraftEntry,
    newConversationUnsentMessagesEntry,
} from "../../services/session-storage/central-session-storage.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError, type PageFailure } from "../format-error.ts";
import { type ComposerAttachmentStore, createComposerAttachmentStore } from "./composer-attachment-store.ts";
import { returnToComposer } from "./composer-return.ts";
import { COMPUTER_REVOKED_MESSAGE, type ComputerEntryOutcome } from "./computer-follower.ts";
import type { ComputerStatusStore, ComputerStatusStoreApi } from "./computer-status-store.ts";
import {
    type ConversationCreationState,
    failedDraftMessage,
    type QueuedDraftMessage,
    transitionConversationCreation,
} from "./conversation-creation-machine.ts";
import {
    type ConversationSelectionEvent,
    type ConversationSelectionState,
    selectedConversationTarget,
    transitionConversationSelection,
} from "./conversation-selection-machine.ts";
import { type DraftControlsStore, draftConfiguration } from "./draft-controls-store.ts";
import { canRetryFirstMessage, canSendFirstMessage, type NewConversationFacts } from "./new-conversation-rules.ts";
import type { OpenMortySession } from "./open-session.ts";
import { prependToDraft, type SubmittedMessage } from "./session-delivery-store.ts";
import type { SessionTitles, SessionTitlesStore } from "./session-titles-store.ts";

export type BotChatHomeStoreApi = Omit<ReturnType<typeof createBotChatHomeStore>, "setState">;

type SetupReason = "unconfigured" | "computer-revoked" | "agent-missing" | "computer-offline" | "agent-required";

/**
 * Whether the home view failed only because the Computer was unreachable, so the workspace retries it once the Computer
 * is back. A selection that is loading again is a retry in flight, not a failure.
 */
export function homeWaitsForComputer(
    home: Pick<BotChatHomeStore, "selection">,
    computer: Pick<ComputerStatusStore, "entry">,
): boolean {
    const selection = home.selection;
    if (selection.kind === "draft") {
        return false;
    }
    return (
        (computer.entry.kind === "failed" && computer.entry.failure === "computer") ||
        (selection.kind === "failed" && selection.failure === "computer")
    );
}

/**
 * What the page shows when it failed before a Session opened: the Session's own load failure first, otherwise the
 * Computer entry's. Either one failing because the Computer is unreachable reads as the Computer being disconnected.
 */
export function preSessionFailure(
    home: Pick<BotChatHomeStore, "selection">["selection"],
    entry: ComputerStatusStore["entry"],
): PageFailure {
    const failed = home.kind === "failed" ? home : entry.kind === "failed" ? entry : null;
    if (failed === null) {
        return { kind: "message", message: "Chat is unavailable." };
    }
    return failed.failure === "computer"
        ? { kind: "computer-disconnected" }
        : { kind: "message", message: failed.message };
}

export interface BotChatNavigation {
    readonly showDraft: () => void;
    readonly showManaged: (target: NativeSessionTarget) => void;
}

export interface BotChatHomeStore {
    readonly composerAttachments: ReturnType<typeof createComposerAttachmentStore>;
    /** The draft written while creating the Session the page followed, until that Session's composer takes it. */
    readonly draftHandoff: {
        readonly sessionTarget: NativeSessionTarget;
        readonly draft: string;
        readonly attachments: ReturnType<typeof createComposerAttachmentStore>;
    } | null;
    readonly selection: ConversationSelectionState;
    readonly creation: ConversationCreationState;
    readonly draft: string;
    /** Bumped whenever the message list should re-arm following the latest message. */
    readonly scrollFollowRevision: number;
    /** Loads the selected Session once the Computer's entry request is answered. */
    readonly load: (signal: AbortSignal) => Promise<void>;
    /**
     * The Computer answered the page's entry request. The selection waiting for it moves in the same step: to loading
     * when the Computer is paired, to a failure when it is not.
     */
    readonly entryAnswered: (outcome: ComputerEntryOutcome) => void;
    /** The pairing was revoked: a Session still loading for it fails. */
    readonly computerRevoked: (message: string) => void;
    readonly newConversation: () => void;
    readonly openManaged: (target: NativeSessionTarget) => void;
    readonly retry: () => void;
    readonly setDraft: (draft: string) => void;
    readonly createConversation: (signal: AbortSignal) => Promise<void>;
    /** Hands the draft written during creation to the Session the page followed; null for any other Session. */
    readonly takeNextDraft: (sessionTarget: NativeSessionTarget) => {
        readonly draft: string;
        readonly attachments: ReturnType<typeof createComposerAttachmentStore>;
    } | null;
}

function initialSelection(urlValue: string, createId: () => string): ConversationSelectionState {
    const parameters = new URL(urlValue).searchParams;
    const target = readNativeSessionTarget({
        harness: parameters.get("harness"),
        sessionId: parameters.get("sessionId"),
    });
    return target !== null ? { kind: "pending", target } : { kind: "draft", key: createId() };
}

/** Setup is a projection of its owning workflows, not a second stored configuration snapshot. */
function homeSetupReason(home: BotChatHomeStore, computer: ComputerStatusStore): SetupReason | null {
    if (computer.pairing.kind === "unpaired") {
        return "unconfigured";
    }
    if (computer.pairing.kind === "revoked") {
        return "computer-revoked";
    }
    if (
        (home.selection.kind === "failed" && home.selection.failure === "agent-required") ||
        (computer.entry.kind === "failed" && computer.entry.failure === "agent-required")
    ) {
        return "agent-required";
    }
    if (home.selection.kind !== "draft" || computer.computerConfiguration === null) {
        return null;
    }
    switch (computerAgentAvailability(computer.computerConfiguration.computer)) {
        case "no-agent":
            return "agent-missing";
        case "offline":
            return "computer-offline";
        case "available":
            return null;
    }
}

export function homeCanStartConversation(home: BotChatHomeStore, computer: ComputerStatusStore): boolean {
    return (
        computer.entry.kind === "ready" &&
        computer.pairing.kind === "paired" &&
        computer.computerConfiguration !== null &&
        homeSetupReason(home, computer) === null
    );
}

function newConversationFacts(
    home: BotChatHomeStore,
    computer: ComputerStatusStore,
    settingsReady: boolean,
    connectionAvailable: boolean,
): NewConversationFacts {
    return {
        connectionAvailable,
        startable: homeCanStartConversation(home, computer),
        draftSelected: home.selection.kind === "draft",
        settingsReady,
        creation: home.creation.kind,
    };
}

function composerMessage(
    home: Pick<BotChatHomeStore, "draft">,
    attachments: Pick<ComposerAttachmentStore, "attachments" | "state">,
) {
    return {
        draft: home.draft,
        attachmentCount: attachments.attachments.length,
        readingAttachments: attachments.state.kind === "reading",
    };
}

/** What the New Session page offers now: the composer's send control and a failed first message's Retry. */
export function newConversationPresentation(
    home: BotChatHomeStore,
    computer: ComputerStatusStore,
    attachments: Pick<ComposerAttachmentStore, "attachments" | "state">,
    settings: DraftControlsStore["settings"],
    connectionAvailable: boolean,
) {
    const facts = newConversationFacts(home, computer, draftConfiguration(settings) !== null, connectionAvailable);
    return {
        submitDisabled: !canSendFirstMessage(facts, composerMessage(home, attachments)),
        retryDisabled: !canRetryFirstMessage(facts),
    } as const;
}

/** A first message no Session took, on its way back to the New Session draft. */
type ReturnedFirstMessage = Pick<QueuedDraftMessage, "attachments" | "commandId" | "content">;

export const createBotChatHomeStore = (
    requests: Pick<
        BotChatApi,
        | "conversationSession"
        | "createConversation"
        | "managedSession"
        | "waitForComputerConfigurationChange"
        | "directory"
    >,
    options: {
        readonly computerId: string;
        /** What the page knows of the Computer, which this store reads and never writes except through its transitions. */
        readonly computer: ComputerStatusStoreApi;
        readonly titles: SessionTitlesStore;
        readonly draftConfiguration: () => ChatDraftConfiguration | null;
        /** Whether the connection header reports the New Session page's connection available, network and Computer included. */
        readonly connectionAvailable: () => boolean;
        readonly entry?: "address" | "restore";
        /** How the Computer answered the page's entry request, or null while it has not. */
        readonly computerEntry: () => ComputerEntryOutcome | null;
        /** Resolves once the Computer answered the page's entry request, which a Session load waits for. */
        readonly computerEntered: (signal: AbortSignal) => Promise<ComputerEntryOutcome>;
        /** An operation through the Computer failed for connectivity: the Computer's follow recovers. */
        readonly onComputerInterrupted: () => void;
        /** An operation reported the Computer's pairing revoked: the Computer's follow waits for setup to repair it. */
        readonly onComputerRevokedByOperation: (message: string, signal: AbortSignal) => Promise<void>;
        /** Announced when the view failed only because the Computer was unreachable and waits for it to be retried. */
        readonly onWaitingForComputer: () => void;
        readonly clock: Clock;
        readonly url: string;
        readonly createId: () => string;
        readonly navigation: BotChatNavigation;
        /**
         * Announced when the page must start over: setup completed, the Computer changed, or a load timed out. The
         * owner restarts the home and directory loads.
         */
        readonly onRestart: () => void;
        /**
         * Announced when another conversation was selected, or the selected one is tried again: the owner restarts the
         * home load, which loads the selected Session. The directory of conversations does not depend on the selection.
         */
        readonly onSelectionChanged: () => void;
        /** Announced when a created conversation joins the directory: the owner reloads it without reloading the home view. */
        readonly onDirectoryRefreshed: () => void;
        /**
         * Hands a created Session its first message: the Session's delivery owns it, durably, from this call until
         * the Computer takes it, whichever conversation is on screen.
         */
        readonly onFirstMessage: (sessionTarget: NativeSessionTarget, message: SubmittedMessage) => void;
        /** Announced after a transition that selects a new draft: the owner reloads the draft controls. */
        readonly onDraftSelected: () => void;
        /** Announced after a transition that targets another conversation: the owner re-scopes the status watch. */
        readonly onSelectionTargeted: (conversationId: NativeSessionTarget | null) => void;
        /** Announced after a transition that makes a selection ready: the owner builds the pane for it. */
        readonly onSelectionReady: (selection: Extract<ConversationSelectionState, { readonly kind: "ready" }>) => void;
    },
) => {
    const computerId = options.computerId;
    const computer = options.computer;
    const titles = options.titles;
    const selection = initialSelection(options.url, options.createId);
    let restoredTarget = options.entry === "restore" && selection.kind === "pending" ? selection.target : null;
    const {
        onRestart,
        onSelectionChanged,
        onDirectoryRefreshed,
        onDraftSelected,
        onSelectionTargeted,
        onSelectionReady,
    } = options;
    return createStore<BotChatHomeStore>()((set, get) => {
        // Announced from the explicit transition sites: a ready selection
        // builds the pane for it, and every selection transition re-scopes
        // the status watch to the selected conversation (null for a draft).
        const announceSelection = (): void => {
            const selection = get().selection;
            onSelectionTargeted(selectedConversationTarget(selection));
            if (selection.kind === "ready") {
                titles.getState().remember(selection.session.target);
                onSelectionReady(selection);
            }
        };
        const acceptLoadedSelection = (
            event: Extract<ConversationSelectionEvent, { readonly kind: "session-loaded" }>,
            startedWith: SessionTitles,
        ): void => {
            const previous = get().selection;
            const selection = transitionConversationSelection(previous, event);
            if (selection === previous) {
                return;
            }
            titles.getState().sessionLoaded(event.session.target, event.session.entry.title, startedWith);
            set({ selection });
            announceSelection();
        };
        // The reload copies of first messages no Session owns yet, oldest first. A copy ends once its Session owns the
        // message or the draft takes it back.
        const unsentEntry = newConversationUnsentMessagesEntry(computerId);
        const unsentFirstMessages = () => centralSessionStorage.read(unsentEntry) ?? [];
        const keepUnsentFirstMessage = (message: { readonly commandId: string; readonly content: string }): void => {
            centralSessionStorage.write(unsentEntry, [
                ...unsentFirstMessages().filter((unsent) => unsent.commandId !== message.commandId),
                message,
            ]);
        };
        const releaseUnsentFirstMessage = (commandId: string): void => {
            const remaining = unsentFirstMessages().filter((unsent) => unsent.commandId !== commandId);
            if (remaining.length === 0) {
                centralSessionStorage.remove(unsentEntry);
            } else {
                centralSessionStorage.write(unsentEntry, remaining);
            }
        };
        // First messages no Session took while the New Session page was not showing them, oldest first. Each keeps
        // its reload copy until a New Session draft takes it back.
        let returned: readonly ReturnedFirstMessage[] = [];
        // The first load restores what an earlier page could not hand to a Session; later loads only load the Session.
        let firstLoadStarted = false;
        /**
         * Returns a first message no Session took to the New Session draft, ahead of what the draft holds, as a reload
         * returns it. Leaving the page that sent it is not discarding it. Off the draft page, or while the draft reads
         * files that restoring would cancel, it waits for the next draft.
         */
        const returnFirstMessage = (message: ReturnedFirstMessage): void => {
            const current = get();
            const composer = current.composerAttachments.getState();
            if (current.selection.kind !== "draft" || composer.state.kind === "reading") {
                returned = [...returned, message];
                return;
            }
            releaseUnsentFirstMessage(message.commandId);
            const restored = returnToComposer(
                current.draft,
                composer.attachments,
                message.content,
                message.attachments,
            );
            if (message.attachments.length > 0) {
                composer.restore(restored.attachments);
            }
            current.setDraft(restored.draft);
        };
        return {
            composerAttachments: createComposerAttachmentStore(),
            draftHandoff: null,
            selection,
            creation: { kind: "draft" },
            draft: "",
            scrollFollowRevision: 0,
            load: async (signal) => {
                signal.throwIfAborted();
                titles.getState().restore();
                const startedWith = titles.getState().titles;
                if (!firstLoadStarted) {
                    firstLoadStarted = true;
                    if (get().selection.kind === "draft") {
                        const draft = centralSessionStorage.read(newConversationDraftEntry(computerId)) ?? "";
                        // First messages an earlier page could not hand to a Session return ahead of the draft, the oldest first.
                        const unsent = unsentFirstMessages();
                        if (unsent.length === 0) {
                            set({ draft });
                        } else {
                            const restored = unsent
                                .toReversed()
                                .reduce((text, message) => prependToDraft(message.content, text), draft);
                            centralSessionStorage.write(newConversationDraftEntry(computerId), restored);
                            centralSessionStorage.remove(unsentEntry);
                            set({ draft: restored });
                        }
                    } else {
                        // A page that opens on another conversation keeps an earlier page's unsent first messages for the next draft.
                        const known = new Set(returned.map((message) => message.commandId));
                        returned = [
                            ...returned,
                            ...unsentFirstMessages()
                                .filter((message) => !known.has(message.commandId))
                                .map((message) => ({ ...message, attachments: [] })),
                        ];
                    }
                }
                // A Session's failure belongs to the load that was in flight for it.
                const failLoad = (
                    failure: "computer" | "agent-required" | "unavailable" | "connection",
                    message: string,
                ): void => {
                    const current = get().selection;
                    if (current.kind === "loading") {
                        set({
                            selection: transitionConversationSelection(current, {
                                kind: "session-load-failed",
                                failure,
                                message,
                                target: current.target,
                            }),
                        });
                    }
                };
                try {
                    // A draft or an open Session has nothing to load.
                    if (get().selection.kind === "draft" || get().selection.kind === "ready") {
                        return;
                    }
                    // An answer the page already holds moves the selection before anything else runs.
                    const outcome = options.computerEntry() ?? (await options.computerEntered(signal));
                    signal.throwIfAborted();
                    get().entryAnswered(outcome);
                    if (outcome.kind === "failed") {
                        // The request this load waited on failed; the Computer's status holds why.
                        const entry = computer.getState().entry;
                        if (entry.kind === "failed") {
                            failLoad(entry.failure, entry.message);
                        }
                        return;
                    }
                    const current = get().selection;
                    if (current.kind !== "loading") {
                        return;
                    }
                    const target = current.target;
                    const session = await requests.managedSession(target, signal);
                    signal.throwIfAborted();
                    acceptLoadedSelection({ kind: "session-loaded", session, target }, startedWith);
                } catch (cause) {
                    if (signal.aborted) {
                        return;
                    }
                    const failedTarget = get().selection;
                    if (
                        cause instanceof CloudApiError &&
                        ["NOT_FOUND", "SESSION_NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED"].includes(
                            cause.code.toUpperCase(),
                        )
                    ) {
                        const target = selectedConversationTarget(failedTarget);
                        if (target !== null) {
                            titles.getState().forget(target);
                        }
                    }
                    if (
                        restoredTarget !== null &&
                        (failedTarget.kind === "pending" || failedTarget.kind === "loading") &&
                        sameNativeSession(failedTarget.target, restoredTarget) &&
                        cause instanceof CloudApiError &&
                        ["NOT_FOUND", "session_not_found"].includes(cause.code)
                    ) {
                        restoredTarget = null;
                        get().newConversation();
                        return;
                    }
                    if (cause instanceof DOMException && cause.name === "TimeoutError") {
                        onRestart();
                        return;
                    }
                    if (isApiConnectionError(cause)) {
                        // A network outage is an ordinary failed call. The Computer's follow recovers from it; a load
                        // the user is still waiting on must not strand the page, so it becomes an operable failure
                        // that keeps its target.
                        options.onComputerInterrupted();
                        console.error("The Morty API request failed.", cause);
                        failLoad("connection", formatError(cause, "Chat is unavailable."));
                        return;
                    }
                    if (cause instanceof CloudApiError && cause.code === "computer_revoked") {
                        await options.onComputerRevokedByOperation(cause.message, signal);
                        return;
                    }
                    if (cause instanceof CloudApiError && cause.code === "AGENT_REQUIRED") {
                        failLoad("agent-required", cause.message);
                        await requests.waitForComputerConfigurationChange(signal);
                        signal.throwIfAborted();
                        set((current) => ({
                            selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                        }));
                        onRestart();
                        return;
                    }
                    const message = formatError(cause, "Chat is unavailable.");
                    if (isComputerConnectionFailure(cause)) {
                        // Only a failed read is eligible for automatic replay; it does not assert the computer is offline.
                        failLoad("computer", message);
                        options.onWaitingForComputer();
                        return;
                    }
                    failLoad("unavailable", message);
                }
            },
            entryAnswered: (outcome) => {
                const current = get().selection;
                if (current.kind !== "pending" && current.kind !== "loading") {
                    return;
                }
                switch (outcome.kind) {
                    case "paired": {
                        const next = transitionConversationSelection(current, { kind: "session-load-started" });
                        if (next !== current) {
                            set({ selection: next });
                        }
                        return;
                    }
                    case "unpaired":
                        set({
                            selection: transitionConversationSelection(current, {
                                kind: "session-load-failed",
                                failure: "unavailable",
                                message: "Connect your local agent to load this session.",
                                target: current.target,
                            }),
                        });
                        return;
                    case "revoked":
                        get().computerRevoked(COMPUTER_REVOKED_MESSAGE);
                        return;
                    case "failed":
                        return;
                    default:
                        return outcome satisfies never;
                }
            },
            computerRevoked: (message) => {
                const current = get().selection;
                if (current.kind === "pending" || current.kind === "loading") {
                    set({
                        selection: transitionConversationSelection(current, {
                            kind: "session-load-failed",
                            failure: "unavailable",
                            message,
                            target: current.target,
                        }),
                    });
                }
            },
            newConversation: () => {
                restoredTarget = null;
                // A first message still in creation stays with its creation; one whose Session could not be created
                // returns to the new draft.
                const failed = failedDraftMessage(get().creation);
                get().composerAttachments.getState().clear();
                const current = get();
                centralSessionStorage.remove(newConversationDraftEntry(computerId));
                // Entry that is not ready starts over; leaving a pending selection releases its request, even when entry
                // configuration is already ready.
                const startOver = !homeCanStartConversation(current, computer.getState());
                const releaseSelection =
                    current.selection.kind === "pending" ||
                    current.selection.kind === "loading" ||
                    current.selection.kind === "failed";
                options.navigation.showDraft();
                const draftKey = options.createId();
                set((state) => ({
                    selection: transitionConversationSelection(state.selection, {
                        kind: "draft-selected",
                        key: draftKey,
                    }),
                    creation: transitionConversationCreation(state.creation, { kind: "reset" }),
                    draft: "",
                    scrollFollowRevision: state.scrollFollowRevision + 1,
                }));
                const waiting = failed === null ? returned : [...returned, failed];
                returned = [];
                // Each returns ahead of the draft, so the oldest goes last to end up first.
                for (const message of [...waiting].reverse()) {
                    returnFirstMessage(message);
                }
                onDraftSelected();
                onSelectionTargeted(null);
                if (startOver) {
                    onRestart();
                } else if (releaseSelection) {
                    onSelectionChanged();
                }
            },
            openManaged: (target) => {
                restoredTarget = null;
                const failed = failedDraftMessage(get().creation);
                get().composerAttachments.getState().clear();
                options.navigation.showManaged(target);
                set((current) => ({
                    selection: transitionConversationSelection(current.selection, {
                        kind: "target-selected",
                        target,
                    }),
                    creation: transitionConversationCreation(current.creation, { kind: "reset" }),
                    scrollFollowRevision: current.scrollFollowRevision + 1,
                }));
                if (failed !== null) {
                    returnFirstMessage(failed);
                }
                onSelectionTargeted(null);
                onSelectionChanged();
            },
            retry: () => {
                set((current) => ({
                    selection: transitionConversationSelection(current.selection, { kind: "retry-requested" }),
                }));
                onRestart();
            },
            setDraft: (draft) => {
                const entry = newConversationDraftEntry(computerId);
                if (draft === "") {
                    centralSessionStorage.remove(entry);
                } else {
                    centralSessionStorage.write(entry, draft);
                }
                set({ draft });
            },
            createConversation: async (signal) => {
                const current = get();
                const composer = get().composerAttachments.getState();
                const { attachments } = composer;
                const draft = current.draft;
                const settings = options.draftConfiguration();
                const facts = newConversationFacts(
                    current,
                    computer.getState(),
                    settings !== null,
                    options.connectionAvailable(),
                );
                const allowed =
                    current.creation.kind === "draft"
                        ? canSendFirstMessage(facts, composerMessage(current, composer))
                        : canRetryFirstMessage(facts);
                // The rule already requires both; checking them again narrows their types.
                if (!allowed || settings === null || current.selection.kind !== "draft") {
                    return;
                }
                const commandId = current.selection.key;
                const content = draft.trim();
                const queuedMessage =
                    current.creation.kind === "draft"
                        ? {
                              attachments,
                              commandId,
                              content,
                              summary: (content || attachments.map((attachment) => attachment.name).join(", ")).slice(
                                  0,
                                  500,
                              ),
                          }
                        : current.creation.message;
                const title = queuedMessage.summary;
                if (current.creation.kind === "draft") {
                    // The submitted snapshot owns its content before any network work begins.
                    get().composerAttachments.getState().clear();
                    centralSessionStorage.remove(newConversationDraftEntry(computerId));
                    if (content.length > 0) {
                        keepUnsentFirstMessage({ commandId, content });
                    }
                }
                set((state) => ({
                    creation: transitionConversationCreation(state.creation, {
                        kind: "draft-message-queued",
                        message: queuedMessage,
                    }),
                    ...(current.creation.kind === "draft" ? { draft: "" } : {}),
                }));
                let access: ChatAccess;
                try {
                    access = await requests.createConversation(commandId, settings, signal);
                    signal.throwIfAborted();
                    set((state) => ({
                        creation: transitionConversationCreation(state.creation, {
                            commandId,
                            kind: "session-created",
                        }),
                    }));
                } catch (cause) {
                    signal.throwIfAborted();
                    set((state) => ({
                        creation: transitionConversationCreation(state.creation, {
                            commandId,
                            error: formatError(cause, "The Session could not be created."),
                            kind: "session-create-failed",
                        }),
                    }));
                    // The page that sent it shows the failure with Retry; once the user has left it, the message
                    // returns to the draft.
                    if (failedDraftMessage(get().creation)?.commandId !== commandId) {
                        returnFirstMessage(queuedMessage);
                    }
                    return;
                }
                signal.throwIfAborted();
                const conversationId = access.target;
                titles.getState().created(conversationId, queuedMessage.summary);
                // The conversation exists, so its first message belongs to it from now on, whatever is on screen.
                // The page follows it only if the user is still on this draft.
                const sending = get().creation;
                const following = sending.kind === "draft-message-sending" && sending.message.commandId === commandId;
                let session: OpenMortySession | null = null;
                if (following) {
                    session = requests.conversationSession(access, { kind: "idle" }, settings.workspaceLabel, title);
                    options.navigation.showManaged(session.target);
                }
                // The Session takes the message and its durable copy in one step, so a reload always finds one.
                options.onFirstMessage(conversationId, {
                    commandId,
                    content: queuedMessage.content,
                    attachments: { kind: "local", values: queuedMessage.attachments },
                    placement: "turn",
                });
                releaseUnsentFirstMessage(commandId);
                if (session !== null) {
                    set((state) => ({
                        creation: transitionConversationCreation(state.creation, {
                            commandId,
                            kind: "conversation-created",
                        }),
                        scrollFollowRevision: state.scrollFollowRevision + 1,
                        selection: transitionConversationSelection(state.selection, {
                            kind: "conversation-created",
                            session,
                        }),
                        // The attachment store moves with the draft, including any read still in progress.
                        draftHandoff: {
                            sessionTarget: conversationId,
                            draft: state.draft,
                            attachments: state.composerAttachments,
                        },
                        draft: "",
                        composerAttachments: createComposerAttachmentStore(),
                    }));
                    centralSessionStorage.remove(newConversationDraftEntry(computerId));
                    announceSelection();
                }
                onDirectoryRefreshed();
            },
            takeNextDraft: (sessionTarget) => {
                const handoff = get().draftHandoff;
                if (handoff === null || !sameNativeSession(handoff.sessionTarget, sessionTarget)) {
                    return null;
                }
                set({ draftHandoff: null });
                return { draft: handoff.draft, attachments: handoff.attachments };
            },
        };
    });
};
