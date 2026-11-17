import { MortyError } from "@portalcrew/morty-client";
import { sameNativeSession } from "@portalcrew/morty-client/native-session";
import { type NativeSessionTarget, readNativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import { isApiConnectionError } from "../../services/api/worker-api-transport.ts";
import {
    type BotChatApi,
    type ChatAccess,
    type ChatDraftConfiguration,
    computerAgentAvailability,
} from "../../services/chat/bot-chat-api.ts";
import { isComputerConnectionFailure } from "../../services/management/management-api.ts";
import {
    centralSessionStorage,
    newConversationDraftEntry,
    newConversationUnsentMessagesEntry,
} from "../../services/session-storage/central-session-storage.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError, isSessionNotFoundFailure, isTimeoutFailure, type PageFailure } from "../format-error.ts";
import { type ComposerAttachmentStore, createComposerAttachmentStore } from "./composer-attachment-store.ts";
import { returnToComposer } from "./composer-return.ts";
import { COMPUTER_REVOKED_MESSAGE } from "./computer-follower.ts";
import {
    type ComputerEntryOutcome,
    type ComputerStatusStore,
    type ComputerStatusStoreApi,
    computerEntryOutcome,
} from "./computer-status-store.ts";
import {
    type ConversationCreationState,
    createsSessionFor,
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
import { createUserMessageCollapseStore, type UserMessageCollapseStore } from "./user-message-collapse-store.ts";

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
    readonly userMessageCollapse: UserMessageCollapseStore;
    readonly composerAttachments: ReturnType<typeof createComposerAttachmentStore>;
    readonly draftHandoff: {
        readonly sessionTarget: NativeSessionTarget;
        readonly draft: string;
        readonly attachments: ReturnType<typeof createComposerAttachmentStore>;
    } | null;
    readonly selection: ConversationSelectionState;
    readonly creation: ConversationCreationState;
    readonly draft: string;
    readonly scrollFollowRevision: number;
    readonly load: (signal: AbortSignal) => Promise<void>;
    /**
     * The Computer answered the page's entry request. The selection waiting for it moves in the same step: to loading
     * when the Computer is paired, to a failure when it is not.
     */
    readonly entryAnswered: (outcome: ComputerEntryOutcome) => void;
    readonly computerRevoked: (message: string) => void;
    readonly newConversation: () => void;
    readonly openManaged: (target: NativeSessionTarget) => void;
    readonly retry: () => void;
    readonly setDraft: (draft: string) => void;
    readonly createConversation: (signal: AbortSignal) => Promise<void>;
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
        (computer.entry.kind === "ready" || computer.entry.kind === "reloading") &&
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

/**
 * The creation a first message asks for: its draft's key and the Session it asks for. The same key with other settings
 * asks for another Session, so it is another creation; under the same identity the Computer would refuse it.
 */
function creationKey(commandId: string, settings: ChatDraftConfiguration): string {
    return JSON.stringify([commandId, settings.harness, settings.workspaceRef, settings.configurations]);
}

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
        readonly connectionAvailable: () => boolean;
        readonly entry?: "address" | "restore";
        readonly computerEntered: (signal: AbortSignal) => Promise<ComputerEntryOutcome>;
        readonly onComputerInterrupted: () => void;
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
        readonly onSelectionChanged: () => void;
        /** Announced when a created conversation joins the directory: the owner reloads it without reloading the home view. */
        readonly onDirectoryRefreshed: () => void;
        readonly onFirstMessage: (sessionTarget: NativeSessionTarget, message: SubmittedMessage) => void;
        readonly onDraftSelected: () => void;
        readonly onSelectionTargeted: (conversationId: NativeSessionTarget | null) => void;
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
        let returned: readonly ReturnedFirstMessage[] = [];
        let firstLoadStarted = false;
        const writeDraft = (key: string, text: string): void => {
            const entry = newConversationDraftEntry(computerId);
            if (text === "") {
                centralSessionStorage.remove(entry);
            } else {
                centralSessionStorage.write(entry, { key, text });
            }
        };
        /**
         * Returns a first message no Session took to the New Session draft, ahead of what the draft holds, as a reload
         * returns it. Leaving the page that sent it is not discarding it. Off the draft page, while the draft reads
         * files that restoring would cancel, or while the draft's own first message is in creation, it waits for the
         * next draft: the draft's text and key belong to that creation until it ends.
         *
         * Its Session may exist even though no answer said so, so the draft takes the message's key: sending it again
         * continues that creation, which answers the Session it already created.
         */
        const returnFirstMessage = (message: ReturnedFirstMessage): void => {
            const current = get();
            const composer = current.composerAttachments.getState();
            if (
                current.selection.kind !== "draft" ||
                composer.state.kind === "reading" ||
                current.creation.kind !== "draft"
            ) {
                returned = [...returned, message];
                return;
            }
            set((state) => ({
                selection: transitionConversationSelection(state.selection, {
                    kind: "draft-selected",
                    key: message.commandId,
                }),
            }));
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
            userMessageCollapse: createUserMessageCollapseStore(),
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
                    const selected = get().selection;
                    if (selected.kind === "draft") {
                        const stored = centralSessionStorage.read(newConversationDraftEntry(computerId));
                        const unsent = unsentFirstMessages();
                        const key = unsent[0]?.commandId ?? stored?.key ?? selected.key;
                        const text = unsent
                            .toReversed()
                            .reduce((text, message) => prependToDraft(message.content, text), stored?.text ?? "");
                        writeDraft(key, text);
                        centralSessionStorage.remove(unsentEntry);
                        set((state) => ({
                            selection: transitionConversationSelection(state.selection, {
                                kind: "draft-selected",
                                key,
                            }),
                            draft: text,
                        }));
                    } else {
                        const known = new Set(returned.map((message) => message.commandId));
                        returned = [
                            ...returned,
                            ...unsentFirstMessages()
                                .filter((message) => !known.has(message.commandId))
                                .map((message) => ({ ...message, attachments: [] })),
                        ];
                    }
                }
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
                    if (get().selection.kind === "draft" || get().selection.kind === "ready") {
                        return;
                    }
                    const outcome =
                        computerEntryOutcome(computer.getState()) ?? (await options.computerEntered(signal));
                    signal.throwIfAborted();
                    get().entryAnswered(outcome);
                    if (outcome.kind === "failed") {
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
                    const notFound = isSessionNotFoundFailure(cause);
                    if (notFound || (cause instanceof MortyError && cause.code === "UNAUTHENTICATED")) {
                        const target = selectedConversationTarget(failedTarget);
                        if (target !== null) {
                            titles.getState().forget(target);
                        }
                    }
                    if (
                        restoredTarget !== null &&
                        (failedTarget.kind === "pending" || failedTarget.kind === "loading") &&
                        sameNativeSession(failedTarget.target, restoredTarget) &&
                        notFound
                    ) {
                        restoredTarget = null;
                        get().newConversation();
                        return;
                    }
                    if (isTimeoutFailure(cause)) {
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
                    if (cause instanceof MortyError && cause.code === "computer_revoked") {
                        await options.onComputerRevokedByOperation(cause.message, signal);
                        return;
                    }
                    if (cause instanceof MortyError && cause.code === "AGENT_REQUIRED") {
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
                const failed = failedDraftMessage(get().creation);
                get().composerAttachments.getState().clear();
                const current = get();
                centralSessionStorage.remove(newConversationDraftEntry(computerId));
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
                const selection = get().selection;
                if (selection.kind === "draft") {
                    writeDraft(selection.key, draft);
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
                const content = draft.trim();
                const queuedMessage =
                    current.creation.kind === "draft"
                        ? {
                              attachments,
                              commandId: current.selection.key,
                              content,
                              summary: (content || attachments.map((attachment) => attachment.name).join(", ")).slice(
                                  0,
                                  500,
                              ),
                          }
                        : current.creation.message;
                const commandId = queuedMessage.commandId;
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
                    access = await requests.createConversation(creationKey(commandId, settings), settings, signal);
                    signal.throwIfAborted();
                } catch (cause) {
                    signal.throwIfAborted();
                    set((state) => ({
                        creation: transitionConversationCreation(state.creation, {
                            commandId,
                            error: formatError(cause, "The Session could not be created."),
                            kind: "session-create-failed",
                        }),
                    }));
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
                const following = createsSessionFor(get().creation, commandId);
                let session: OpenMortySession | null = null;
                if (following) {
                    session = requests.conversationSession(access, settings.workspaceLabel, title);
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
