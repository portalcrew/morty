import {
    type MortyClient,
    MortyError,
    MortyPageRequest,
    type MortySessionEventObserver,
    MortyTimeoutError,
} from "@morty-build/client";
import type {
    NativeSessionTarget,
    SessionConfigurationSelection,
    SessionEvent,
    SessionLiveEvent,
} from "@morty-build/client/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { saveLastHarnessPreference } from "../../services/chat/last-harness-preference.ts";
import { recordBrowserDiagnostic } from "../../services/diagnostics/browser-diagnostics.ts";
import type { Clock } from "../../services/time/clock.ts";
import { formatError, isRetryableComputerConnectionFailure, isSessionClosedFailure } from "../format-error.ts";
import { reportApplicationError } from "../report-error.ts";
import { agentQuestionAnswer, openAgentQuestions } from "./agent-question-answer.ts";
import type { ComposerAttachmentStore } from "./composer-attachment-store.ts";
import { createBrowserFilePreviewStore } from "./file-preview-store.ts";
import type { SelectedMortySession } from "./open-session.ts";
import { uploadPromptAttachments } from "./prompt-attachment-upload.ts";
import { startRecoveryNotice } from "./recovery-notice.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";
import type { SessionComposerStore } from "./session-composer-store.ts";
import {
    connectionFailure,
    connectionWaitsForComputer,
    disconnectedConnection,
    type SessionConnection,
    sessionReconnectAttempt,
    sessionUpdatesEndedError,
} from "./session-connection.ts";
import { acceptedTurn, ownerRunsTurn, workingIndicator } from "./session-current-turn.ts";
import { sessionDeliveryPresentation } from "./session-delivery-presentation.ts";
import {
    awaitingMessage,
    type DeliveryPlacement,
    type DeliveryState,
    deliveryMessages,
    journalMessage,
    type SessionDeliveryStore,
    type SubmitTurn,
    type SubmittedMessage,
} from "./session-delivery-store.ts";
import {
    executionReadBasis,
    type LiveExecutionChange,
    type SessionExecutionFact,
    type SessionExecutionState,
    sessionActivity,
    waitingForInput,
} from "./session-execution.ts";
import { type SessionLifecycleFact, sessionLifecycleFact } from "./session-lifecycle.ts";
import {
    type ChatQueuedMessage,
    queuedMessages,
    queueFailure,
    type SessionMessageQueueStore,
} from "./session-message-queue-store.ts";
import type { SessionConnectionFollower } from "./session-operation-connection.ts";
import {
    canChangeSettings,
    canRetryFailedMessage,
    canRetryUnknownDelivery,
    canSend,
    canSubmit,
    composerHasMessage,
    type SessionOperationFacts,
} from "./session-operation-rules.ts";
import type { SessionPageState } from "./session-page-state.ts";
import {
    createSessionMessageReduction,
    type SessionExecutionMessage,
    sessionEventCommandIds,
    sessionReductionMessages,
    sessionUserCommandIds,
} from "./session-presentation.ts";
import {
    createSessionProjection,
    observeSessionProjectionExecution,
    type SessionEventHistory,
    type SessionProjection,
    type SessionProjectionEffect,
    type SessionProjectionInput,
    sessionProjectionExecutionOwner,
    sessionProjectionOlderHistory,
    sessionProjectionPagination,
    sessionProjectionTimeline,
    transitionSessionProjection,
} from "./session-projection.ts";
import type { SessionRename, SessionRenameStore } from "./session-rename-store.ts";
import type { SessionSettingsStore } from "./session-settings-store.ts";
import { type SessionTaskControlsStore, stopFailure, stopRequested } from "./session-task-controls.ts";
import { type SessionTitlesStore, sessionTitle } from "./session-titles-store.ts";
import { createSessionWelcomeStore } from "./session-welcome-store.ts";

/**
 * What views see of a pane: its stores and the user's actions. Starting, stopping and reconnecting the pane is its
 * owner's.
 */
export type SessionPaneModel = Omit<ReturnType<typeof createSessionPaneModel>, "start" | "stop" | "reconnect">;

/** Renaming the Session. A failed rename closes the editor and keeps its failure until the next edit. */
export type TitleEdit =
    | { readonly kind: "closed" }
    | { readonly kind: "editing"; readonly draft: string }
    | { readonly kind: "saving"; readonly draft: string }
    | { readonly kind: "failed"; readonly message: string };

/** What the title editor shows: the draft being edited in this pane, otherwise the rename the Session holds. */
export function sessionTitleEdit(draft: string | null, rename: SessionRename): TitleEdit {
    if (draft !== null) {
        return { kind: "editing", draft };
    }
    switch (rename.kind) {
        case "none":
            return { kind: "closed" };
        case "waiting":
        case "sending":
        case "refreshing":
            return { kind: "saving", draft: rename.title };
        case "failed":
            return { kind: "failed", message: rename.message };
        default:
            return rename satisfies never;
    }
}

export type { SessionConnection } from "./session-connection.ts";

/**
 * The pane's account of its Session's work, including submissions the Computer never saw; none until its connection
 * first reaches the Computer, as the Session's execution state has nothing of the Computer's yet.
 */
export function paneActivity(
    connection: SessionConnection,
    execution: Pick<SessionExecutionState, "turn" | "commands">,
    delivery: DeliveryState,
): SessionActivityState | null {
    return connection.kind === "first-loading" ? null : sessionActivity(execution, delivery);
}

/** The connection of no pane, for a view that follows the open pane's connection when none is open. */
export const noSessionPane = createStore<Pick<SessionPaneStore, "connection">>()(() => ({
    connection: { kind: "first-loading" },
}));

const SESSION_EVENT_PAGE_LIMIT = 30;
const HISTORY_MESSAGE_TARGET = 20;
export interface SessionPaneStore {
    readonly connection: SessionConnection;
    /**
     * The Session's history as this connection follows it, the only source of the timeline. Its messages, older
     * history and revision are read through `sessionProjectionTimeline`.
     */
    readonly projection: SessionProjection;
    /**
     * Bumped after a user-submitted action that appends content (send, queue,
     * steer) so the message surface re-arms following the latest message.
     */
    readonly followRevision: number;
    readonly recover: (signal: AbortSignal) => Promise<void>;
    readonly retryNow: () => void;
    /**
     * Records that the Computer archived the Session and ends the connection for good. `reason` is the Computer's
     * explanation, or null when a failed operation was the only sign of the closing.
     */
    readonly sessionClosed: (reason: string | null) => void;
    /**
     * Loads the page of history before the oldest message shown. The load runs on the pane's lifetime: `signal` only
     * ends the caller's wait for it.
     */
    readonly loadOlderMessages: (signal: AbortSignal) => Promise<void>;
    readonly setDraft: (draft: string) => void;
    readonly send: () => Promise<void>;
    /** Picks a suggested answer to a question the user can still answer. */
    readonly chooseAnswer: (messageId: string, questionIndex: number, answer: string) => void;
    /**
     * Answers the questions a message asks with the picked answers, as a message of its own sent the way the
     * composer sends it. The composer's draft stays as it is.
     */
    readonly sendAnswer: (messageId: string) => Promise<void>;
    readonly removeUnknownDelivery: () => void;
    /** Retries on the Session's delivery: the attempt may outlive this pane. */
    readonly retryUnknownDelivery: () => Promise<void>;
    readonly retryFailedMessage: () => Promise<void>;
    readonly editFailedMessage: () => void;
    readonly discardFailedMessage: () => void;
    readonly steerQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly deleteQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    /** Takes a queued message out of the queue and back into the composer, ahead of any draft, for editing. */
    readonly editQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly configure: (selection: SessionConfigurationSelection, signal: AbortSignal) => Promise<void>;
    readonly openTitleEdit: () => void;
    readonly setTitleDraft: (draft: string) => void;
    readonly confirmTitleEdit: (signal: AbortSignal) => Promise<void>;
    readonly cancelTitleEdit: () => void;
    readonly stop: (signal: AbortSignal) => Promise<void>;
}

/**
 * Where a submitted message comes from: the composer's draft, an answer to a question an Agent message asks, or a
 * message delivery already holds (the Session's first message, or a failed one sent again).
 */
type SubmissionSource = "composer" | "answer" | "held";

/** The pane's state with its connection loop, which only the pane's own `start` runs. */
interface SessionPaneState extends SessionPaneStore {
    readonly connect: (signal: AbortSignal) => Promise<void>;
}

/** The pane's state as the operation rules read it, for the presentation and the actions alike. */
function sessionOperationFacts(
    model: Pick<SessionPaneStore, "connection">,
    execution: Pick<SessionExecutionState, "turn" | "interactions">,
    delivery: Pick<SessionDeliveryStore, "state">,
    tasks: Pick<SessionTaskControlsStore, "stopRequest">,
    settings: Pick<SessionSettingsStore, "change">,
    connectionAvailable: boolean,
): SessionOperationFacts {
    return {
        connectionAvailable,
        connection: model.connection.kind,
        stopping: stopRequested(tasks, acceptedTurn(execution.turn)),
        configuring: settings.change.kind === "configuring",
        delivery: delivery.state.kind,
        waitingForInput: waitingForInput(execution.interactions),
    };
}

export function sessionPanePresentation(
    model: SessionPaneStore,
    execution: SessionExecutionState,
    composer: Pick<SessionComposerStore, "draft" | "titleDraft">,
    rename: SessionRenameStore,
    delivery: SessionDeliveryStore,
    tasks: SessionTaskControlsStore,
    queue: SessionMessageQueueStore,
    attachments: ComposerAttachmentStore,
    settings: Pick<SessionSettingsStore, "change">,
    connectionAvailable: boolean,
) {
    const facts = sessionOperationFacts(model, execution, delivery, tasks, settings, connectionAvailable);
    const timeline = sessionProjectionTimeline(model.projection);
    const olderHistory = sessionProjectionOlderHistory(model.projection);
    const activity = sessionActivity(execution, delivery.state);
    // Which turn runs is the current turn's; the stop control only adds whether the user asked to stop it.
    const running = acceptedTurn(execution.turn);
    const controlRunning = running !== null;
    const stopping = facts.stopping;
    const composerInputDisabled =
        model.connection.kind === "closed" || facts.configuring || facts.waitingForInput || stopping;
    const unknownDelivery = delivery.state.kind === "delivery-unknown" ? journalMessage(delivery.state.journal) : null;
    const deliveryUnknownCommandId = unknownDelivery?.commandId ?? null;
    const deliveryUnknownUserMessageId = deliveryUnknownCommandId === null ? null : deliveryUnknownCommandId;
    const deliveries = sessionDeliveryPresentation(timeline.messages, execution, delivery, queue);
    const pendingMessage = deliveries.pendingDelivery?.message ?? null;
    const pendingDelivery = deliveries.pendingDelivery;
    const hasFailureCard =
        activity.kind === "failed" &&
        timeline.messages.some(
            (message) =>
                message.commandId === activity.commandId &&
                message.role === "assistant" &&
                message.presentation.kind === "failure",
        );
    const authenticationFailure =
        model.connection.kind !== "closed" &&
        activity.kind === "failed" &&
        activity.code === "authentication_required" &&
        !hasFailureCard
            ? activity
            : null;
    return {
        activity,
        authenticationFailure,
        composerInputDisabled,
        settingsDisabled: !canChangeSettings(facts),
        settingsNotice: controlRunning ? "New settings may not affect this response." : null,
        settingsStopDisabled:
            !connectionAvailable || model.connection.kind !== "ready" || stopping || ownerRunsTurn(execution.turn),
        stopDisabled: !connectionAvailable || model.connection.kind !== "ready" || ownerRunsTurn(execution.turn),
        canSuggestProgress:
            !controlRunning &&
            canSend(facts) &&
            composer.draft.length === 0 &&
            attachments.attachments.length === 0 &&
            attachments.state.kind !== "reading",
        // Operations that failed because the Session closed say nothing the closed notice does not already say.
        composerError:
            model.connection.kind === "closed" || pendingDelivery?.error != null
                ? ""
                : ([
                      activity,
                      sessionTitleEdit(composer.titleDraft, rename.rename),
                      olderHistory,
                      settings.change,
                      delivery.state.kind === "failed"
                          ? { kind: "failed" as const, message: delivery.state.failure.message }
                          : delivery.state,
                  ]
                      .filter((state) => state.kind === "failed")
                      .find(
                          (state) =>
                              // A turn failure belongs to its timeline card. Keep the
                              // composer fallback only when that command has no card.
                              !("commandId" in state) || (!hasFailureCard && authenticationFailure === null),
                      )?.message ??
                  stopFailure(tasks, running) ??
                  queueFailure(queue, execution.queued) ??
                  ""),
        deliveryUnknownUserMessageId,
        hasOlderHistory: timeline.hasOlderHistory,
        historyLoading: olderHistory.kind === "loading",
        outputState:
            delivery.state.kind === "preparing"
                ? "sending"
                : stopping
                  ? "stopping"
                  : delivery.state.kind === "submitting"
                    ? "sending"
                    : controlRunning
                      ? "running"
                      : "idle",
        workingIndicator: workingIndicator(execution.turn, facts.waitingForInput),
        retryFailedDisabled: pendingMessage === null || !canRetryFailedMessage(facts),
        retryUnknownDeliveryDisabled: unknownDelivery === null || !canRetryUnknownDelivery(facts),
        submitDisabled:
            !composerHasMessage(composer.draft, attachments.attachments.length, attachments.state.kind === "reading") ||
            !canSend(facts),
        // An answer to an Agent's question goes out as the composer's message would, whatever the draft holds.
        answerDisabled: !canSend(facts),
        ...deliveries,
    } as const;
}

async function readSessionHistory(
    client: MortyClient,
    sessionTarget: NativeSessionTarget,
    initialCursor: string | null,
    newerEvents: readonly SessionEvent[],
    expectedSessionGenerationId: string | null,
    signal: AbortSignal,
    loadedRange: { readonly generation: string; readonly firstEventId: string | null } | null = null,
): Promise<SessionEventHistory> {
    let events: readonly SessionEvent[] = newerEvents;
    let nextCursor = initialCursor;
    // Loading the newest page can itself restore native history and replace the
    // generation announced by a preceding live event. That page owns the baseline;
    // only older pages must match the generation we have already adopted.
    let sessionGenerationId = initialCursor === null ? null : expectedSessionGenerationId;
    let throughPosition: string | null = null;
    let renderableMessages = sessionReductionMessages(createSessionMessageReduction({ events, nextCursor }));
    do {
        const requestedCursor = nextCursor;
        const page = await client.events.list(
            sessionTarget,
            new MortyPageRequest(SESSION_EVENT_PAGE_LIMIT, requestedCursor ?? ""),
            signal,
        );
        signal.throwIfAborted();
        // Only the newest page defines which live deltas the snapshot covers.
        if (requestedCursor === initialCursor) {
            throughPosition = page.throughPosition;
        }
        if (sessionGenerationId !== null && page.sessionGenerationId !== sessionGenerationId) {
            throw new Error("The Session reloaded while message history was loading.");
        }
        if (requestedCursor !== null && page.nextCursor === requestedCursor) {
            throw new Error("The Computer returned the same message-history cursor twice.");
        }
        sessionGenerationId = page.sessionGenerationId;
        events = mergeSessionEvents(page.events, events);
        nextCursor = page.nextCursor;
        renderableMessages = sessionReductionMessages(createSessionMessageReduction({ events, nextCursor }));
    } while (
        nextCursor !== null &&
        (renderableMessages.length < HISTORY_MESSAGE_TARGET ||
            (loadedRange !== null &&
                loadedRange.generation === sessionGenerationId &&
                loadedRange.firstEventId !== null &&
                !events.some((event) => event.eventId === loadedRange.firstEventId)))
    );
    if (sessionGenerationId === null || throughPosition === null) {
        throw new Error("The Computer returned no Session history generation.");
    }
    return { events, nextCursor, sessionGenerationId, throughPosition };
}

/** The history a projection already shows, which a reload reads at least back to. */
function loadedRange(
    projection: SessionProjection,
): Extract<SessionProjection, { readonly kind: "established" }> | null {
    return projection.kind === "established" ? projection : null;
}

/** Waits for `work` until it settles or `signal` ends the wait; the work itself goes on. */
async function untilSettledOrAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

function mergeSessionEvents(
    current: readonly SessionEvent[],
    incoming: readonly SessionEvent[],
): readonly SessionEvent[] {
    const byId = new Map(current.map((event) => [event.eventId, event]));
    for (const event of incoming) {
        byId.set(event.eventId, event);
    }
    return [...byId.values()];
}

export function createSessionPaneModel(options: {
    readonly clock: Clock;
    readonly session: SelectedMortySession;
    /** What the page holds for the Session, which outlives this pane. */
    readonly sessionPage: SessionPageState;
    readonly attachmentSignal: AbortSignal;
    readonly computerId: string;
    readonly requests: Pick<BotChatApi, "connectSession" | "managedSession" | "computerConfiguration">;
    /**
     * Hands the owner this pane's last account of the Session's work when the pane stops, or null when it had none.
     * While it runs, the owner derives the Session's status from the pane's account instead.
     */
    readonly onReleased?: ((activity: SessionActivityState | null) => void) | undefined;
    readonly titles: SessionTitlesStore;
    /** Whether the connection header reports this Session's connection available, network and Computer included. */
    readonly connectionAvailable: (connection: SessionConnection) => boolean;
    /** The connection reached the Session through the Computer. */
    readonly onConnected: () => void;
    /** The connection used up its automatic retries and waits for the owner's `reconnect`. */
    readonly onWaitingForComputer: () => void;
}) {
    const { session, computerId, requests, clock, titles } = options;
    const { composer, delivery, execution, queue: messageQueue, rename, settings, tasks } = options.sessionPage;
    const composerAttachments = composer.getState().attachments;
    const sessionTarget = session.result.ready.target;
    // Working in a conversation makes its harness the reference for the next draft. Its settings carry into New
    // Session only where the user changes them: the others are the Agent's and its directory's, which the draft reads
    // for itself.
    saveLastHarnessPreference(computerId, session.harness);
    const openedAt = Date.now();
    // The turn the Session was opened with, which this pane follows from its start.
    const openedRunning =
        session.result.action === "conversation" && session.result.activeTurn.kind === "running"
            ? { commandId: session.result.activeTurn.commandId, turnId: session.result.activeTurn.turnId }
            : null;
    let client: MortyClient | null = null;
    let recoveryRequested = false;
    let countdownInterrupt: AbortController | null = null;
    // The Computer closed the Session. The connect loop turns this into the closed connection state.
    let closure: { readonly reason: string | null } | null = null;
    // The running connection attempt, which a closing of the Session interrupts.
    let attempt: AbortController | null = null;
    // The pane's lifetime: its owner starts it once and stops it once, so at most one connection loop ever runs for
    // the pane. React attaching or detaching its view is not part of it.
    const lifetime = new AbortController();
    let phase: "created" | "started" | "stopped" = "created";
    // This pane's following of the Session for its operations, from `start` until `stop`.
    let follower: SessionConnectionFollower | null = null;
    /**
     * Whether a failure through `connected` says the Session is closed now. A client that a reconnection
     * replaced describes the Session as it was, so its failure must not close the Session this pane follows now.
     */
    const closedThrough = (connected: MortyClient, cause: unknown): cause is MortyError =>
        isSessionClosedFailure(cause) && connected === client;
    /** Closes this pane when an operation through `connected` found the Session closed now. */
    const failedThrough = (connected: MortyClient, cause: unknown): void => {
        if (closedThrough(connected, cause)) {
            store.getState().sessionClosed(cause.message);
        }
    };
    /**
     * Submits through the client its owner keeps alive for the attempt. The pane releases its viewing client when
     * it stops; delivery independently releases its own client when the attempt settles.
     */
    const submitTurn =
        (connected: MortyClient | null): SubmitTurn =>
        async (request, signal) => {
            if (connected === null) {
                throw new Error("The Session is not connected.");
            }
            try {
                const turn = await connected.turns.submit(sessionTarget, request, signal);
                return { turnId: turn.turnId, queued: turn.state.kind === "queued" };
            } catch (cause) {
                failedThrough(connected, cause);
                throw cause;
            }
        };
    /** The messages the timeline shows now. */
    const timelineMessages = (): readonly SessionExecutionMessage[] =>
        sessionProjectionTimeline(store.getState().projection).messages;
    const queuedMessage = (commandId: string): ChatQueuedMessage | null =>
        queuedMessages(
            execution.getState().state.queued,
            messageQueue.getState(),
            deliveryMessages(delivery.getState()),
        ).find((message) => message.commandId === commandId) ?? null;
    const store = createStore<SessionPaneState>()((set, get) => {
        const operationFacts = (): SessionOperationFacts =>
            sessionOperationFacts(
                get(),
                execution.getState().state,
                delivery.getState(),
                tasks.getState(),
                settings.getState(),
                options.connectionAvailable(get().connection),
            );
        let connectionChangedAt = clock.now();
        let recoveryNoticeDeadline: AbortController | null = null;
        const setAndSettle = (
            partial:
                | SessionPaneState
                | Partial<SessionPaneState>
                | ((state: SessionPaneState) => SessionPaneState | Partial<SessionPaneState>),
        ): void => {
            const previous = get().connection.kind;
            set(partial);
            const connection = get().connection;
            const current = connection.kind;
            if (
                current !== "reconnecting" &&
                (connection.kind !== "disconnected" || connection.retry.kind === "exhausted")
            ) {
                recoveryNoticeDeadline?.abort();
                recoveryNoticeDeadline = null;
            }
            if (current !== previous) {
                const now = clock.now();
                recordBrowserDiagnostic({
                    at: new Date().toISOString(),
                    component: "web",
                    operation: "session-connection",
                    outcome: current,
                    elapsedMs: Math.max(0, now - connectionChangedAt),
                    requestId: "",
                });
                connectionChangedAt = now;
            }
            follower?.changed();
        };
        /**
         * Submits `commandId` through `connected`. The service's acceptance is a fact about the Session's execution: a
         * message the Computer runs at once becomes the current turn, dated by `startedAt`, when this browser sent it,
         * until the Computer reports its start; until then the turn is its delivery's. A message the Computer queued
         * starts no turn yet.
         */
        const submitCommand =
            (connected: MortyClient | null, commandId: string, startedAt: number): SubmitTurn =>
            async (request, signal) => {
                const accepted = await submitTurn(connected)(request, signal);
                signal.throwIfAborted();
                execution.getState().apply({
                    kind: "acknowledged",
                    commandId,
                    turnId: accepted.turnId,
                    queued: accepted.queued,
                    startedAt,
                });
                return accepted;
            };
        let historyLoadController: AbortController | null = null;
        /**
         * Moves the timeline to `projection`, and tells the Session's execution which commands it now shows and which
         * `recorded` commands the history it adopted records.
         */
        const setProjection = (projection: SessionProjection, recorded: readonly string[] = []): void => {
            set({ projection });
            execution.getState().apply({
                kind: "history",
                shown: sessionUserCommandIds(sessionProjectionTimeline(projection).messages),
                recorded,
            });
        };
        /**
         * Applies a fact to the Session's execution and marks the timeline where the fact asks it to. Returns whether
         * the fact asks for a fresh read of the execution.
         */
        const applyExecution = (fact: SessionExecutionFact): boolean => {
            let read = false;
            for (const effect of execution.getState().apply(fact)) {
                switch (effect.kind) {
                    case "mark-timeline": {
                        const projection = observeSessionProjectionExecution(get().projection, effect);
                        if (projection !== get().projection) {
                            setProjection(projection);
                        }
                        break;
                    }
                    case "read":
                        read = true;
                        break;
                    default:
                        effect satisfies never;
                }
            }
            return read;
        };
        /** Reads the Computer's execution and applies it; the Session's execution state decides whether it is news. */
        const readExecution = async (
            connected: MortyClient,
            signal: AbortSignal,
            deliveryCommandId: string | null = null,
        ): Promise<void> => {
            const basis = executionReadBasis(execution.getState().state);
            const snapshot = await connected.sessions.readSessionExecution(
                sessionTarget,
                signal,
                deliveryCommandId ?? undefined,
            );
            signal.throwIfAborted();
            await observeExecution(
                { kind: "read", snapshot, basis, deliveryCommandId, readAt: Date.now() },
                connected,
                signal,
            );
        };
        /** Applies a fact to the Session's execution, and performs the read it asks for through `connected`. */
        const observeExecution = async (
            fact: SessionExecutionFact,
            connected: MortyClient,
            signal: AbortSignal,
        ): Promise<void> => {
            if (applyExecution(fact)) {
                await readExecution(connected, signal);
            }
        };
        /** What a lifecycle event says about the Session's execution, as this pane's timeline places it. */
        const liveExecutionChange = (
            fact: SessionLifecycleFact,
            event: SessionLiveEvent,
        ): LiveExecutionChange | null => {
            switch (fact.kind) {
                case "interaction-requested":
                case "permission-resolved":
                case "elicitation-resolved":
                case "queue-changed":
                    return fact;
                case "turn-started": {
                    const owner = sessionProjectionExecutionOwner(get().projection, fact.commandId);
                    return {
                        kind: "turn-started",
                        commandId: fact.commandId,
                        startedAt: Date.parse(event.recordedAt),
                        steers: owner !== null && owner !== fact.commandId,
                    };
                }
                case "turn-delegated":
                    return { ...fact, at: Date.parse(event.recordedAt) };
                case "turn-completed":
                    return {
                        kind: "turn-ended",
                        commandId: fact.commandId,
                        outcome: fact.steered ? { kind: "steered" } : { kind: "completed" },
                    };
                case "turn-failed":
                    return {
                        kind: "turn-ended",
                        commandId: fact.commandId,
                        outcome: { kind: "failed", failure: { code: fact.code, message: fact.message } },
                    };
                case "none":
                    return null;
                default:
                    return fact satisfies never;
            }
        };
        /** Moves the projection by `input`, and tells the Session's execution what the moved timeline shows. */
        const commitProjection = (
            input: SessionProjectionInput,
            recorded: readonly string[] = [],
        ): readonly SessionProjectionEffect[] => {
            const result = transitionSessionProjection(get().projection, input);
            if (result.state !== get().projection) {
                setProjection(result.state, recorded);
            }
            for (const effect of result.effects) {
                if (effect.kind !== "adopted") {
                    continue;
                }
                if (effect.title !== undefined) {
                    titles.getState().observed(sessionTarget, effect.title);
                }
            }
            return result.effects;
        };
        const loadProjectionHistory = async (
            effect: Extract<SessionProjectionEffect, { readonly kind: "load-history" }>,
            connected: MortyClient,
            parentSignal: AbortSignal,
        ): Promise<void> => {
            historyLoadController?.abort();
            const controller = new AbortController();
            historyLoadController = controller;
            const revision = get().projection.revision;
            const deadline = new AbortController();
            const signal = AbortSignal.any([parentSignal, controller.signal, deadline.signal]);
            void clock.sleep(45_000, signal).then(
                () => deadline.abort(new DOMException("The Session history read timed out.", "TimeoutError")),
                () => undefined,
            );
            try {
                const history = await readSessionHistory(
                    connected,
                    sessionTarget,
                    null,
                    [],
                    effect.generation,
                    signal,
                    loadedRange(get().projection),
                );
                parentSignal.throwIfAborted();
                const current = get().projection;
                if (controller.signal.aborted || current.pending === null || current.revision !== revision) {
                    return;
                }
                const effects = commitProjection(
                    { history, kind: "history-loaded", revision },
                    sessionEventCommandIds(history.events),
                );
                if (effects.some((loaded) => loaded.kind === "read-settings")) {
                    settings
                        .getState()
                        .readInBackground(
                            (readSignal) => connected.sessions.readConfiguration(sessionTarget, readSignal),
                            parentSignal,
                        );
                }
            } catch (cause) {
                parentSignal.throwIfAborted();
                if (controller.signal.aborted || get().projection.revision !== revision) {
                    return;
                }
                // This pane owns the history deadline. The session client only sees an aborted
                // caller signal, so retain timeout semantics for subscription recovery.
                if (deadline.signal.aborted) {
                    throw new MortyTimeoutError({ cause });
                }
                throw cause;
            } finally {
                deadline.abort();
                if (historyLoadController === controller) {
                    historyLoadController = null;
                }
            }
        };
        const dispatchProjection = async (
            input: SessionProjectionInput,
            connected: MortyClient,
            signal: AbortSignal,
        ): Promise<void> => {
            const effects = commitProjection(input);
            for (const effect of effects) {
                if (effect.kind === "load-history") {
                    await loadProjectionHistory(effect, connected, signal);
                } else if (effect.kind === "read-settings") {
                    settings
                        .getState()
                        .readInBackground(
                            (readSignal) => connected.sessions.readConfiguration(sessionTarget, readSignal),
                            signal,
                        );
                }
            }
        };
        // Ends the connect loop on a closed Session: it runs nothing, so its turn, queue and interactions settle.
        const showClosed = (reason: string | null): void => {
            applyExecution({ kind: "closed" });
            setAndSettle({ connection: { kind: "closed", reason } });
        };
        /**
         * Submits a message: the composer's draft, an answer to an Agent's question, a failed message again, or the
         * first message the Session's delivery holds. Delivery owns that snapshot and the attempt through
         * preparation, sending, and recovery, so the attempt outlives this pane; completion never writes to the next
         * draft.
         */
        const submit = async (
            submitted: Omit<SubmittedMessage, "placement">,
            source: SubmissionSource,
        ): Promise<void> => {
            if (!canSubmit(operationFacts())) {
                return;
            }
            // Shown in the queue while a turn runs, otherwise as the next turn, until the Computer says which it is.
            const placement: DeliveryPlacement = execution.getState().state.turn.kind === "current" ? "queue" : "turn";
            const message: SubmittedMessage = { ...submitted, placement };
            const { commandId } = message;
            welcome.getState().dismiss();
            const sentAt = Date.now();
            const observed = client;
            let deliveryClient: MortyClient | null = null;
            const releaseClients: (() => void)[] = [];
            const sending = delivery.getState().send(message, {
                prepare: async ({ attachments, content }, attemptSignal) => {
                    if (observed === null) {
                        throw new Error("The Session is not connected.");
                    }
                    // Delivery outlives the viewing pane and owns its transport until the attempt settles.
                    const connected = await requests.connectSession(sessionTarget, attemptSignal);
                    deliveryClient = connected;
                    releaseClients.push(() => connected.close());
                    const uploadedAttachments =
                        attachments.kind === "uploaded"
                            ? attachments.values
                            : await uploadPromptAttachments(
                                  connected.sessions,
                                  sessionTarget,
                                  attachments.values,
                                  attemptSignal,
                              );
                    // Freeze semantic intent before delivery owns retries, including identity.
                    return {
                        attachments: uploadedAttachments,
                        content: content.trim(),
                    };
                },
                submit: async (request, signal) => {
                    return await submitCommand(deliveryClient, commandId, sentAt)(request, signal);
                },
            });
            // Only a message taken from the composer leaves it.
            if (source === "composer") {
                composer.getState().sent();
            }
            if (placement === "turn") {
                execution.getState().apply({ kind: "turn-submitted" });
            }
            set({ followRevision: get().followRevision + 1 });
            // The retained submission owns its failure; the composer keeps the next draft.
            try {
                await sending;
            } catch (cause) {
                if (observed !== null) {
                    failedThrough(observed, cause);
                }
                throw cause;
            } finally {
                for (const release of releaseClients) {
                    release();
                }
            }
        };
        /** The message that answers a still open question message with the answers picked for it, if they are complete. */
        const pickedAnswer = (messageId: string): string | null => {
            const questions = openAgentQuestions(timelineMessages()).get(messageId);
            return questions === undefined
                ? null
                : agentQuestionAnswer(questions, composer.getState().answerChoices.get(messageId) ?? {});
        };
        /** Sends a message the user wrote, which the Computer runs now or queues behind the Session's earlier work. */
        const sendMessage = async (
            content: string,
            attachments: readonly ComposerAttachment[],
            source: SubmissionSource,
        ): Promise<void> => {
            if (!canSend(operationFacts())) {
                return;
            }
            await submit(
                {
                    commandId: crypto.randomUUID(),
                    content,
                    attachments: { kind: "local", values: attachments },
                },
                source,
            );
        };
        /** The load of the page before the oldest message shown that runs now, which every caller waits on. */
        let olderHistoryLoad: Promise<void> | null = null;
        const loadOlderHistory = async (): Promise<void> => {
            const pagination = sessionProjectionPagination(get().projection);
            if (pagination === null || client === null) {
                return;
            }
            const connected = client;
            const { revision } = pagination;
            commitProjection({ kind: "older-page-requested", revision });
            try {
                const page = await readSessionHistory(
                    connected,
                    sessionTarget,
                    pagination.nextCursor,
                    [],
                    pagination.generation,
                    lifetime.signal,
                );
                commitProjection({ kind: "older-page", page, revision });
            } catch (cause) {
                if (lifetime.signal.aborted) {
                    return;
                }
                if (closedThrough(connected, cause)) {
                    commitProjection({ kind: "older-page-failed", revision, message: null });
                    get().sessionClosed(cause.message);
                    return;
                }
                commitProjection({
                    kind: "older-page-failed",
                    revision,
                    message: formatError(cause, "Older messages could not be loaded."),
                });
                throw cause;
            }
        };
        return {
            connection: { kind: "first-loading" },
            projection: createSessionProjection(),
            followRevision: 0,
            loadOlderMessages: async (signal) => {
                if (olderHistoryLoad === null) {
                    const loading = loadOlderHistory().finally(() => {
                        if (olderHistoryLoad === loading) {
                            olderHistoryLoad = null;
                        }
                    });
                    olderHistoryLoad = loading;
                }
                await untilSettledOrAborted(olderHistoryLoad, signal);
            },
            connect: async (signal) => {
                let consecutiveFailures = 0;
                // Only the first connection reuses the access that opened the Session. Every reconnection asks Chat
                // again, so access that ended meanwhile, including a revoked Session credential, ends the page's access.
                let openedAccess = session.result.action === "conversation" ? session.result.access : undefined;
                const paneSignal = signal;
                // One grace period per interruption, shared by backoff and reconciliation.
                // Successful recovery or a terminal outcome cancels it in the connection transition above.
                const recoveryNotice = (): "quiet" | "visible" => {
                    const current = get().connection;
                    if (recoveryNoticeDeadline !== null && !recoveryNoticeDeadline.signal.aborted) {
                        return current.kind === "disconnected" || current.kind === "reconnecting"
                            ? current.notice
                            : "quiet";
                    }
                    recoveryNoticeDeadline = startRecoveryNotice({
                        clock,
                        signal: paneSignal,
                        onNotice: (notice) => {
                            const connection = get().connection;
                            if (connection.kind === "disconnected" || connection.kind === "reconnecting") {
                                setAndSettle({ connection: { ...connection, notice } });
                            }
                        },
                    });
                    return "quiet";
                };
                // The signal is this attempt's own: the pane's lifetime, and also the closing of the Session.
                const observeSession = async (signal: AbortSignal): Promise<void> => {
                    const access = openedAccess;
                    openedAccess = undefined;
                    client = await requests.connectSession(sessionTarget, signal, access);
                    const connected = client;
                    /** Feeds a lifecycle event to the Session's execution, which decides whether it is news. */
                    const receiveLifecycle = async (
                        fact: SessionLifecycleFact,
                        event: SessionLiveEvent,
                    ): Promise<void> => {
                        const change = liveExecutionChange(fact, event);
                        if (change === null) {
                            return;
                        }
                        await observeExecution(
                            {
                                kind: "live",
                                sessionGenerationId: event.sessionGenerationId,
                                position: event.position,
                                change,
                            },
                            connected,
                            signal,
                        );
                    };
                    const observer: MortySessionEventObserver = {
                        reconcile: async () => {
                            await dispatchProjection({ kind: "reconcile" }, connected, signal);
                            signal.throwIfAborted();
                            // Confirm execution after history is adopted. An earlier idle snapshot
                            // cannot settle work that started while those pages were loading.
                            const submission = delivery.getState().state;
                            await readExecution(
                                connected,
                                signal,
                                submission.kind === "delivery-unknown" ? submission.journal.commandId : null,
                            );
                        },
                        receive: async (events) => {
                            for (const event of events) {
                                // History and lifecycle processing belong to this event. Observe both immediately,
                                // so cancellation or failure in either cannot leave the other's rejection unhandled.
                                await Promise.all([
                                    dispatchProjection({ event, kind: "live-event" }, connected, signal),
                                    event.type === "acp"
                                        ? Promise.resolve()
                                        : receiveLifecycle(sessionLifecycleFact(event.payload), event),
                                ]);
                                await new Promise<void>((resolve) => queueMicrotask(resolve));
                                signal.throwIfAborted();
                            }
                            return true;
                        },
                    };
                    const subscription = await connected.events.subscribeLive(sessionTarget, observer, signal);
                    signal.throwIfAborted();
                    setAndSettle({ connection: { kind: "ready", client: connected } });
                    options.onConnected();
                    const monitoring = new AbortController();
                    const monitorSignal = AbortSignal.any([signal, monitoring.signal]);
                    void (async () => {
                        try {
                            await clock.sleep(25_000, monitorSignal);
                            monitorSignal.throwIfAborted();
                            // Reset backoff only after the subscription stays open; transport
                            // heartbeats detect lost connections without polling Session execution.
                            if (get().connection.kind === "ready" && client === connected) {
                                consecutiveFailures = 0;
                            }
                        } catch {
                            // The subscription owns and cancels this monitor.
                        }
                    })();
                    try {
                        welcome.getState().connected();
                        // The first message the Session holds is submitted by the first pane that connects.
                        const awaiting = awaitingMessage(delivery.getState().state);
                        if (awaiting !== null) {
                            await submit(awaiting, "held");
                            signal.throwIfAborted();
                        }
                        await subscription.completed;
                    } finally {
                        monitoring.abort();
                    }
                    signal.throwIfAborted();
                    throw sessionUpdatesEndedError();
                };
                for (;;) {
                    if (closure !== null) {
                        showClosed(closure.reason);
                        return;
                    }
                    if (consecutiveFailures > 0) {
                        setAndSettle({
                            connection: {
                                kind: "reconnecting",
                                message: connectionFailure(get().connection),
                                notice: recoveryNotice(),
                            },
                        });
                    }
                    const running = new AbortController();
                    attempt = running;
                    try {
                        await observeSession(AbortSignal.any([signal, running.signal]));
                    } catch (failure) {
                        const cause = running.signal.aborted ? running.signal.reason : failure;
                        running.abort();
                        attempt = null;
                        if (client !== null) {
                            options.sessionPage.connection.release(client);
                        }
                        client = null;
                        if (signal.aborted) {
                            return;
                        }
                        if (isSessionClosedFailure(cause)) {
                            closure ??= { reason: cause.message };
                        }
                        if (closure !== null) {
                            continue;
                        }
                        const retryable = isRetryableComputerConnectionFailure(cause);
                        if (recoveryRequested) {
                            recoveryRequested = false;
                            consecutiveFailures = 0;
                        }
                        const retry = retryable
                            ? sessionReconnectAttempt(consecutiveFailures)
                            : { kind: "exhausted" as const };
                        consecutiveFailures += 1;
                        recordBrowserDiagnostic({
                            at: new Date().toISOString(),
                            component: "web",
                            operation: "session-interruption",
                            outcome: cause instanceof MortyError ? cause.code : "api_unavailable",
                            attempt: consecutiveFailures,
                            elapsedMs: 0,
                            requestId: "",
                        });
                        const message = formatError(cause, "The Session could not be opened.");
                        setAndSettle({
                            connection: retryable
                                ? disconnectedConnection(
                                      message,
                                      retry.kind === "scheduled" ? retry.delayMs : null,
                                      recoveryNotice(),
                                  )
                                : { kind: "failed", message },
                        });
                        countdownInterrupt = new AbortController();
                        const retrySignal = AbortSignal.any([signal, countdownInterrupt.signal]);
                        try {
                            if (retry.kind === "scheduled") {
                                const retryAt = clock.now() + retry.delayMs;
                                while (clock.now() < retryAt) {
                                    await clock.sleep(Math.min(1000, retryAt - clock.now()), retrySignal);
                                    retrySignal.throwIfAborted();
                                    setAndSettle({
                                        connection: disconnectedConnection(
                                            message,
                                            retryAt - clock.now(),
                                            recoveryNotice(),
                                        ),
                                    });
                                }
                            } else {
                                if (retryable) {
                                    // The automatic retries are used up: the owner retries once it sees the Computer
                                    // reachable again, and the user can retry at any time.
                                    options.onWaitingForComputer();
                                }
                                await new Promise<void>((resolve) => {
                                    if (retrySignal.aborted) {
                                        resolve();
                                        return;
                                    }
                                    retrySignal.addEventListener("abort", () => resolve(), { once: true });
                                });
                            }
                        } catch (cause) {
                            if (!retrySignal.aborted) {
                                throw cause;
                            }
                        }
                        countdownInterrupt = null;
                        if (signal.aborted) {
                            return;
                        }
                    }
                }
            },
            recover: async (parent) => {
                parent.throwIfAborted();
                const state = get().connection;
                if (state.kind === "disconnected") {
                    // A foreground hint can expedite recovery without replenishing
                    // every short-lived connection's retry budget.
                    if (state.retry.kind === "exhausted") {
                        recoveryRequested = true;
                    }
                    countdownInterrupt?.abort(new Error("The browser resumed."));
                    return;
                }
            },
            retryNow: () => {
                recoveryRequested = true;
                countdownInterrupt?.abort(new Error("Retried now"));
            },
            sessionClosed: (reason) => {
                const current = get().connection;
                // A failed operation and the Computer's notice can both report one closing; the notice has the reason.
                if (current.kind === "closed") {
                    if (current.reason === null && reason !== null) {
                        set({ connection: { ...current, reason } });
                    }
                    return;
                }
                if (closure !== null) {
                    if (closure.reason === null && reason !== null) {
                        closure = { reason };
                    }
                    return;
                }
                closure = { reason };
                // The connect loop takes over: it stops the running attempt or retry countdown and shows the closing.
                attempt?.abort(new Error("The Session closed."));
                countdownInterrupt?.abort(new Error("The Session closed."));
            },
            setDraft: (draft) => {
                tasks.getState().dismissFailure();
                messageQueue.getState().dismissFailure();
                composer.getState().setDraft(draft);
            },
            send: async () => {
                const { attachments, state: attachmentState } = composerAttachments.getState();
                const draft = composer.getState().draft;
                if (!composerHasMessage(draft, attachments.length, attachmentState.kind === "reading")) {
                    return;
                }
                await sendMessage(draft, attachments, "composer");
            },
            chooseAnswer: (messageId, questionIndex, answer) => {
                const open = new Set(openAgentQuestions(timelineMessages()).keys());
                composer.getState().chooseAnswer(open, messageId, questionIndex, answer);
            },
            sendAnswer: async (messageId) => {
                const answer = pickedAnswer(messageId);
                if (answer !== null) {
                    await sendMessage(answer, [], "answer");
                }
            },
            removeUnknownDelivery: () => {
                delivery.getState().discardUnknown();
            },
            retryUnknownDelivery: async () => {
                const state = delivery.getState().state;
                if (state.kind !== "delivery-unknown" || !canRetryUnknownDelivery(operationFacts())) {
                    return;
                }
                const pending = state.journal;
                if (pending.placement === "turn") {
                    execution.getState().apply({ kind: "turn-submitted" });
                }
                // Without a record of when this browser sent it, the retry dates the command's work.
                const observed = client;
                const startedAt = Date.now();
                const retrying: SubmitTurn = async (request, signal) => {
                    const connected = await requests.connectSession(sessionTarget, signal);
                    try {
                        return await submitCommand(connected, pending.commandId, startedAt)(request, signal);
                    } catch (cause) {
                        if (observed !== null) {
                            failedThrough(observed, cause);
                        }
                        throw cause;
                    } finally {
                        connected.close();
                    }
                };
                await delivery.getState().retry(retrying);
            },
            retryFailedMessage: async () => {
                const state = delivery.getState().state;
                const message =
                    state.kind === "preparation-failed"
                        ? // Nothing reached the Computer, so the message keeps its identity.
                          state.message
                        : state.kind === "failed"
                          ? // The Computer definitively rejected this identity and will not run it again.
                            { ...journalMessage(state.journal), commandId: crypto.randomUUID() }
                          : null;
                if (message === null || !canRetryFailedMessage(operationFacts())) {
                    return;
                }
                await submit(message, "held");
            },
            editFailedMessage: () => {
                if (composerAttachments.getState().state.kind === "reading") {
                    return;
                }
                const message = delivery.getState().takeFailedMessage();
                if (message === null) {
                    return;
                }
                tasks.getState().dismissFailure();
                messageQueue.getState().dismissFailure();
                composer
                    .getState()
                    .returnMessage(
                        message.content,
                        message.attachments.kind === "uploaded" && message.attachments.values.length > 0,
                        message.attachments.kind === "local" ? message.attachments.values : [],
                    );
            },
            discardFailedMessage: () => {
                delivery.getState().takeFailedMessage();
            },
            steerQueued: async (commandId, signal) => {
                if (await messageQueue.getState().steerMessage(queuedMessage(commandId), signal)) {
                    set({ followRevision: get().followRevision + 1 });
                }
            },
            deleteQueued: async (commandId, signal) =>
                await messageQueue.getState().deleteMessage(queuedMessage(commandId), signal),
            editQueued: async (commandId, signal) =>
                await messageQueue.getState().editMessage(queuedMessage(commandId), signal),
            configure: async (selection, signal) => {
                if (!canChangeSettings(operationFacts())) {
                    return;
                }
                await settings.getState().configure(selection, signal);
            },
            openTitleEdit: () => {
                // A new edit replaces the failure the last rename left.
                if (rename.getState().rename.kind === "failed") {
                    rename.getState().clearFailure();
                }
                composer.getState().openTitleEdit(sessionTitle(titles.getState().titles, sessionTarget));
            },
            setTitleDraft: (draft) => composer.getState().setTitleDraft(draft),
            cancelTitleEdit: () => composer.getState().closeTitleEdit(),
            confirmTitleEdit: async (signal) => {
                const draft = composer.getState().titleDraft;
                if (draft === null) {
                    return;
                }
                composer.getState().closeTitleEdit();
                const trimmed = draft.trim();
                if (trimmed.length === 0 || trimmed === sessionTitle(titles.getState().titles, sessionTarget)) {
                    return;
                }
                await rename.getState().confirm(trimmed, signal);
            },
            stop: async (signal) => await tasks.getState().stop(acceptedTurn(execution.getState().state.turn), signal),
        };
    });
    const welcome = createSessionWelcomeStore({
        computerId,
        sessionTarget,
        fillEmptyDraft: (text) => {
            const presentation = sessionPanePresentation(
                store.getState(),
                execution.getState().state,
                composer.getState(),
                rename.getState(),
                delivery.getState(),
                tasks.getState(),
                messageQueue.getState(),
                composerAttachments.getState(),
                settings.getState(),
                options.connectionAvailable(store.getState().connection),
            );
            if (!presentation.canSuggestProgress) {
                return false;
            }
            store.getState().setDraft(text);
            return true;
        },
    });
    /** This pane's connection once ready; the pane follows the Session while it runs, so the Session's is this one. */
    const waitForConnectionReady = (signal: AbortSignal): Promise<MortyClient> =>
        options.sessionPage.connection.ready(signal);
    const readFile = async (path: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        const current = store.getState().connection;
        if (current.kind !== "ready") {
            throw new MortyError("session_not_connected", "The Session is not connected.");
        }
        return await current.client.sessions.readFile(
            sessionTarget,
            path,
            AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(20_000)]),
            32 * 1024 * 1024,
        );
    };
    const readResource = async (path: string, signal: AbortSignal) => {
        // The same bounded lifetime covers connection recovery and the file read.
        const requestSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(20_000)]);
        await waitForConnectionReady(requestSignal);
        return await readFile(path, requestSignal);
    };
    const filePreview = createBrowserFilePreviewStore(readFile);
    /**
     * Starts the pane's Session connection. The owner that created the pane starts it once; the connection then
     * follows the Session, its interruptions and its closing until the owner stops the pane.
     */
    const start = (): void => {
        if (phase !== "created") {
            return;
        }
        phase = "started";
        // This pane now follows the Session for the page: it shows the settings and the running turn the Session was
        // opened with, and carries the Session's operations on its connection. What the user asked the Session stays.
        settings.getState().opened(session.result.ready);
        execution.getState().apply({ kind: "opened", running: openedRunning, openedAt });
        follower = options.sessionPage.connection.follow({
            connection: () => store.getState().connection,
            failedThrough,
        });
        void store
            .getState()
            .connect(lifetime.signal)
            .catch((cause: unknown) => {
                if (!lifetime.signal.aborted) {
                    reportApplicationError(cause, "session-pane-connect");
                }
            });
    };
    /**
     * Starts the next attempt of a connection that used up its automatic retries, without restoring them: the owner
     * calls it when it sees the Computer reachable again, and a failed attempt waits for the owner's next call.
     */
    const reconnect = (): void => {
        if (connectionWaitsForComputer(store.getState().connection)) {
            countdownInterrupt?.abort(new Error("The Computer is reachable again."));
        }
    };
    /**
     * Ends the pane: its connection and everything bound to its lifetime. The Session's operations go on, waiting for
     * the next pane's connection. The owner stops a pane it replaces or removes; a stopped pane is never restarted.
     * Idempotent.
     */
    const stop = (): void => {
        if (phase === "stopped") {
            return;
        }
        phase = "stopped";
        follower?.stopped();
        follower = null;
        filePreview.getState().close();
        lifetime.abort(new Error("The session pane stopped."));
        options.onReleased?.(
            paneActivity(store.getState().connection, execution.getState().state, delivery.getState().state),
        );
    };
    // Views read the pane's state and invoke the user's actions; the connection loop stays with `start`.
    const paneStore: StoreApi<SessionPaneStore> = store;
    return {
        composer,
        composerAttachments,
        attachmentSignal: options.attachmentSignal,
        execution,
        interactions: options.sessionPage.interactions,
        settings,
        store: paneStore,
        delivery,
        rename,
        filePreview,
        messageQueue,
        tasks,
        welcome,
        /** The agent the session runs on; the harness lock offers it. */
        harness: session.harness,
        /** The opened session record; scopes the execution context. */
        session,
        /** Whether the Session's Agent lets a queued message steer the running turn. */
        steeringSupported: session.result.ready.capabilities.steering,
        start,
        stop,
        reconnect,
        /**
         * The signal for what the user asks the Session to do: the Session's operations lifetime on this page, which
         * switching panes does not end.
         */
        operationsSignal: () => options.sessionPage.lifetime,
        readResource,
    };
}
