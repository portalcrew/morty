import {
    type FileReadProgress,
    type MortyClient,
    MortyError,
    type MortySessionEventObserver,
} from "@portalcrew/morty-client";
import type { SessionConfigurationSelection } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { BotChatApi } from "../../services/chat/bot-chat-api.ts";
import { centralLocalStorage, lastHarnessEntry } from "../../services/local-storage/central-local-storage.ts";
import type { Clock } from "../../services/time/clock.ts";
import { agentQuestionAnswer, openAgentQuestions } from "./agent-question-answer.ts";
import { createBrowserFilePreviewStore } from "./file-preview-store.ts";
import type { SelectedMortySession } from "./open-session.ts";
import { acceptedTurn } from "./session-current-turn.ts";
import { deliveryMessages, settledDelivery, unconfirmedJournal } from "./session-delivery-store.ts";
import { visibleQueue } from "./session-execution.ts";
import { createSessionExecutionFeed } from "./session-execution-feed.ts";
import { type ChatQueuedMessage, queuedMessages } from "./session-message-queue-store.ts";
import {
    canChangeSettings,
    canDeleteQueued,
    canEditQueued,
    canRemoveUnknownDelivery,
    canRetryFailedMessage,
    canRetryUnknownDelivery,
    canSend,
    canSteerQueued,
    canStop,
    composerHasMessage,
    type SessionOperationFacts,
} from "./session-operation-rules.ts";
import type { SessionPageState } from "./session-page-state.ts";
import { createSessionPaneConnection, type SessionConnection } from "./session-pane-connection.ts";
import { createSessionHistory } from "./session-pane-history.ts";
import { sessionOperationFacts, sessionPanePresentation } from "./session-pane-presentation.ts";
import { sessionProjectionTimeline } from "./session-projection.ts";
import { type SessionTitlesStore, sessionTitle } from "./session-titles-store.ts";
import { createSessionWelcomeStore } from "./session-welcome-store.ts";

export type SessionPaneModel = Omit<ReturnType<typeof createSessionPaneModel>, "start" | "stop" | "reconnect">;

export interface SessionPaneStore {
    /**
     * Bumped after a user-submitted action that appends content (send, queue,
     * steer) so the message surface re-arms following the latest message.
     */
    readonly followRevision: number;
    readonly setDraft: (draft: string) => void;
    readonly send: () => Promise<void>;
    readonly chooseAnswer: (messageId: string, questionIndex: number, answer: string) => void;
    readonly sendAnswer: (messageId: string) => Promise<void>;
    readonly removeUnknownDelivery: (signal: AbortSignal) => Promise<void>;
    readonly retryUnknownDelivery: () => Promise<void>;
    readonly retryFailedMessage: () => Promise<void>;
    readonly editFailedMessage: () => void;
    readonly discardFailedMessage: () => void;
    readonly steerQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly deleteQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly editQueued: (commandId: string, signal: AbortSignal) => Promise<void>;
    readonly configure: (selection: SessionConfigurationSelection, signal: AbortSignal) => Promise<void>;
    readonly openTitleEdit: () => void;
    readonly setTitleDraft: (draft: string) => void;
    readonly confirmTitleEdit: (signal: AbortSignal) => Promise<void>;
    readonly cancelTitleEdit: () => void;
    readonly stop: (signal: AbortSignal) => Promise<void>;
}

export function createSessionPaneModel(options: {
    readonly clock: Clock;
    readonly session: SelectedMortySession;
    readonly sessionPage: SessionPageState;
    readonly attachmentSignal: AbortSignal;
    readonly computerId: string;
    readonly requests: Pick<BotChatApi, "connectSession" | "managedSession" | "computerConfiguration">;
    readonly titles: SessionTitlesStore;
    readonly connectionAvailable: (connection: SessionConnection) => boolean;
    readonly onConnected: () => void;
    readonly onWaitingForComputer: () => void;
}) {
    const { session, computerId, requests, clock, titles, sessionPage } = options;
    const { composer, delivery, execution, feedback, queue, rename, settings, submission, tasks } = sessionPage;
    /** The user asked something of the Session again: the last failure no longer describes what they see. */
    const acted = (): void => feedback.getState().dismiss();
    const composerAttachments = composer.getState().attachments;
    const sessionTarget = session.target;
    // Working in a conversation makes its harness the reference for the next draft. Its settings carry into New
    // Session only where the user changes them: the others are the Agent's and its directory's, which the draft reads
    // for itself.
    centralLocalStorage.write(lastHarnessEntry(computerId), sessionTarget.harness);
    // The pane's lifetime: its owner starts it once and stops it once, so at most one connection loop ever runs for
    // the pane. React attaching or detaching its view is not part of it.
    const lifetime = new AbortController();
    let phase: "created" | "started" | "stopped" = "created";

    const history = createSessionHistory({
        clock,
        sessionTarget,
        lifetime: lifetime.signal,
        execution,
        settings,
        feedback,
        titles,
        connectedClient: () => paneConnection.client(),
        failedThrough: (connected, cause) => paneConnection.failedThrough(connected, cause),
    });
    const feed = createSessionExecutionFeed({ sessionTarget, execution, executionOwner: history.executionOwner });
    const observer = (connected: MortyClient, signal: AbortSignal): MortySessionEventObserver => ({
        reconcile: async () => {
            await history.dispatch({ kind: "reconcile" }, connected, signal);
            signal.throwIfAborted();
            const { state } = settledDelivery(delivery.getState(), execution.getState().state);
            await feed.read(connected, signal, unconfirmedJournal(state)?.commandId);
        },
        receive: async (events) => {
            for (const event of events) {
                // History and lifecycle processing belong to this event. Observe both immediately,
                // so cancellation or failure in either cannot leave the other's rejection unhandled.
                await Promise.all([
                    history.dispatch({ event, kind: "live-event" }, connected, signal),
                    feed.receive(event, connected, signal),
                ]);
                await new Promise<void>((resolve) => queueMicrotask(resolve));
                signal.throwIfAborted();
            }
            return true;
        },
    });
    const paneConnection = createSessionPaneConnection({
        clock,
        sessionTarget,
        requests,
        operations: sessionPage.connection,
        openedAccess: session.origin.kind === "created" ? session.origin.access : undefined,
        observer,
        subscribed: async (signal) => {
            welcome.getState().connected();
            await submitted(submission.sendAwaiting());
            signal.throwIfAborted();
        },
        onConnected: options.onConnected,
        onWaitingForComputer: options.onWaitingForComputer,
        onClosed: () => {
            execution.getState().apply({ kind: "closed" });
        },
    });
    const connection = paneConnection.store;
    const shownConnection = (): SessionConnection => connection.getState().connection;

    const operationFacts = (): SessionOperationFacts =>
        sessionOperationFacts({
            connection: shownConnection(),
            execution: execution.getState().state,
            interactions: sessionPage.interactions.getState(),
            delivery: delivery.getState(),
            tasks: tasks.getState(),
            settings: settings.getState(),
            connectionAvailable: options.connectionAvailable(shownConnection()),
            steeringSupported: session.ready.capabilities.steering,
        });
    const timelineMessages = () =>
        sessionProjectionTimeline(history.store.getState().projection, execution.getState().state.observations)
            .messages;
    const queuedMessage = (commandId: string): ChatQueuedMessage | null =>
        queuedMessages(
            visibleQueue(execution.getState().state),
            queue.getState(),
            deliveryMessages(settledDelivery(delivery.getState(), execution.getState().state)),
        ).find((message) => message.commandId === commandId) ?? null;
    const followLatest = (): void => store.setState({ followRevision: store.getState().followRevision + 1 });
    const submitted = async (sending: Promise<void> | null): Promise<void> => {
        if (sending !== null) {
            welcome.getState().dismiss();
            followLatest();
            await sending;
        }
    };
    const store = createStore<SessionPaneStore>()(() => ({
        followRevision: 0,
        setDraft: (draft) => {
            acted();
            composer.getState().setDraft(draft);
        },
        send: async () => {
            const { attachments, state } = composerAttachments.getState();
            if (
                composerHasMessage(composer.getState().draft, attachments.length, state.kind === "reading") &&
                canSend(operationFacts())
            ) {
                await submitted(submission.sendDraft());
            }
        },
        chooseAnswer: (messageId, questionIndex, answer) => {
            const open = new Set(openAgentQuestions(timelineMessages()).keys());
            composer.getState().chooseAnswer(open, messageId, questionIndex, answer);
        },
        sendAnswer: async (messageId) => {
            const questions = openAgentQuestions(timelineMessages()).get(messageId);
            const answer =
                questions === undefined
                    ? null
                    : agentQuestionAnswer(questions, composer.getState().answerChoices.get(messageId) ?? {});
            if (answer !== null && canSend(operationFacts())) {
                await submitted(submission.sendAnswer(answer));
            }
        },
        removeUnknownDelivery: async (signal) => {
            if (canRemoveUnknownDelivery(operationFacts())) {
                acted();
                await delivery.getState().withdrawUnknown(queue.getState().withdrawUnconfirmed, signal);
            }
        },
        retryUnknownDelivery: async () => {
            if (canRetryUnknownDelivery(operationFacts())) {
                await submission.retryUnknown();
            }
        },
        retryFailedMessage: async () => {
            if (canRetryFailedMessage(operationFacts())) {
                await submitted(submission.retryFailed());
            }
        },
        editFailedMessage: () => {
            if (composerAttachments.getState().state.kind === "reading") {
                return;
            }
            const message = delivery.getState().takeFailedMessage();
            if (message === null) {
                return;
            }
            acted();
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
            const message = queuedMessage(commandId);
            if (message === null || !canSteerQueued(operationFacts(), message)) {
                return;
            }
            acted();
            if (await queue.getState().steerMessage(message, signal)) {
                followLatest();
            }
        },
        deleteQueued: async (commandId, signal) => {
            const message = queuedMessage(commandId);
            if (message !== null && canDeleteQueued(operationFacts(), message)) {
                acted();
                await queue.getState().deleteMessage(message, signal);
            }
        },
        editQueued: async (commandId, signal) => {
            const message = queuedMessage(commandId);
            if (message !== null && canEditQueued(operationFacts(), message)) {
                acted();
                await queue.getState().editMessage(message, signal);
            }
        },
        configure: async (selection, signal) => {
            if (!canChangeSettings(operationFacts())) {
                return;
            }
            acted();
            await settings.getState().configure(selection, signal);
        },
        openTitleEdit: () => {
            acted();
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
        stop: async (signal) => {
            if (!canStop(operationFacts())) {
                return;
            }
            acted();
            await tasks.getState().stop(acceptedTurn(execution.getState().state.turn), signal);
        },
    }));
    const welcome = createSessionWelcomeStore({
        computerId,
        sessionTarget,
        fillEmptyDraft: (text) => {
            const presentation = sessionPanePresentation({
                connection: shownConnection(),
                projection: history.store.getState().projection,
                execution: execution.getState().state,
                interactions: sessionPage.interactions.getState(),
                composer: composer.getState(),
                delivery: delivery.getState(),
                tasks: tasks.getState(),
                queue: queue.getState(),
                attachments: composerAttachments.getState(),
                settings: settings.getState(),
                feedback: feedback.getState(),
                connectionAvailable: options.connectionAvailable(shownConnection()),
                steeringSupported: session.ready.capabilities.steering,
            });
            if (!presentation.canSuggestProgress) {
                return false;
            }
            store.getState().setDraft(text);
            return true;
        },
    });
    /** The read's own timeout bounds each wait for more of the file; the caller bounds the whole read if it must. */
    const readFile = async (
        path: string,
        signal: AbortSignal,
        maximumBytes: number,
        onProgress?: (progress: FileReadProgress) => void,
    ) => {
        signal.throwIfAborted();
        const current = shownConnection();
        if (current.kind !== "ready") {
            throw new MortyError("session_not_connected", "The Session is not connected.");
        }
        return await current.client.sessions.readFile(
            sessionTarget,
            path,
            AbortSignal.any([signal, lifetime.signal]),
            maximumBytes,
            onProgress,
        );
    };
    const readResource = async (path: string, signal: AbortSignal) => {
        const requestSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(20_000)]);
        await sessionPage.connection.ready(requestSignal);
        return await readFile(path, requestSignal, 32 * 1024 * 1024);
    };
    const filePreview = createBrowserFilePreviewStore(readFile);
    const start = (): void => {
        if (phase !== "created") {
            return;
        }
        phase = "started";
        settings.getState().opened(session.ready);
        execution.getState().apply({ kind: "opened" });
        paneConnection.start(lifetime.signal);
    };
    /**
     * Starts the next attempt of a connection that used up its automatic retries, without restoring them: the owner
     * calls it when it sees the Computer reachable again, and a failed attempt waits for the owner's next call.
     */
    const reconnect = (): void => {
        connection.getState().computerReachable();
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
        paneConnection.stop();
        filePreview.getState().close();
        lifetime.abort(new Error("The session pane stopped."));
    };
    return {
        userMessageCollapse: sessionPage.userMessageCollapse,
        composer,
        composerAttachments,
        attachmentSignal: options.attachmentSignal,
        execution,
        interactions: sessionPage.interactions,
        settings,
        store,
        connection,
        history: history.store,
        delivery,
        feedback,
        rename,
        filePreview,
        messageQueue: queue,
        tasks,
        welcome,
        harness: sessionTarget.harness,
        session,
        steeringSupported: session.ready.capabilities.steering,
        start,
        stop,
        reconnect,
        operationsSignal: () => sessionPage.lifetime,
        readResource,
    };
}
