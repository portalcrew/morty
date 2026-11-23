import type { ComposerAttachmentStore } from "./composer-attachment-store.ts";
import type { SessionComposerStore } from "./session-composer-store.ts";
import type { SessionConnection } from "./session-connection.ts";
import { acceptedTurn, ownerRunsTurn, workingIndicator } from "./session-current-turn.ts";
import { sessionDeliveryPresentation } from "./session-delivery-presentation.ts";
import { type SessionDeliveryStore, settledDelivery, unconfirmedJournal } from "./session-delivery-store.ts";
import { type SessionExecutionState, sessionActivity, visibleQueue } from "./session-execution.ts";
import type { SessionForkStore } from "./session-fork-store.ts";
import { type SessionInteractionStore, waitingForInput } from "./session-interaction-store.ts";
import type { ChatQueuedMessage, SessionMessageQueueStore } from "./session-message-queue-store.ts";
import { operationFailureMessage, type SessionOperationFeedbackStore } from "./session-operation-feedback.ts";
import {
    canChangeSettings,
    canDeleteQueued,
    canEditQueued,
    canFork,
    canRemoveUnknownDelivery,
    canRetryFailedMessage,
    canRetryUnknownDelivery,
    canSend,
    canSteerQueued,
    canStop,
    composerHasMessage,
    queuedMessageEditable,
    type SessionOperationFacts,
} from "./session-operation-rules.ts";
import {
    type SessionProjection,
    sessionProjectionOlderHistory,
    sessionProjectionTimeline,
} from "./session-projection.ts";
import type { SessionRename } from "./session-rename-store.ts";
import { type SessionSettingsStore, settingsChanging } from "./session-settings-store.ts";
import { type SessionTaskControlsStore, stopInFlight } from "./session-task-controls.ts";

export type TitleEdit =
    | { readonly kind: "closed" }
    | { readonly kind: "editing"; readonly draft: string }
    | { readonly kind: "saving"; readonly draft: string };

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
        default:
            return rename satisfies never;
    }
}

export function sessionOperationFacts(input: {
    readonly connection: SessionConnection;
    readonly execution: SessionExecutionState;
    readonly interactions: Pick<SessionInteractionStore, "submissions">;
    readonly delivery: Pick<SessionDeliveryStore, "state" | "accepted">;
    readonly tasks: Pick<SessionTaskControlsStore, "stopInFlight">;
    readonly settings: Pick<SessionSettingsStore, "change">;
    readonly fork: Pick<SessionForkStore, "fork">;
    readonly connectionAvailable: boolean;
    readonly steeringSupported: boolean;
    readonly forkSupported: boolean;
}): SessionOperationFacts {
    const { execution } = input;
    const { turn } = execution;
    return {
        connectionAvailable: input.connectionAvailable,
        connection: input.connection.kind,
        // This page's own request counts until the Computer's account reflects it or the turn ends.
        stopping: turn.kind === "current" && (turn.stop === "stopping" || stopInFlight(input.tasks, turn.commandId)),
        configuring: settingsChanging(input.settings),
        delivery: settledDelivery(input.delivery, execution).state,
        waitingForInput: waitingForInput(execution.interactions, input.interactions.submissions),
        ownerRunsTurn: ownerRunsTurn(execution.turn),
        steeringSupported: input.steeringSupported,
        forkSupported: input.forkSupported,
        forking: input.fork.fork.kind === "forking",
        turnRunning: turn.kind === "current",
        queued: visibleQueue(execution).length > 0,
    };
}

function queuedMessagePresentation(facts: SessionOperationFacts, message: ChatQueuedMessage) {
    return {
        ...message,
        editDisabled: !canEditQueued(facts, message),
        editLabel: queuedMessageEditable(message)
            ? `Edit queued message: ${message.summary}`
            : "This message's files cannot be restored here. Delete it and send it again.",
        steerDisabled: !canSteerQueued(facts, message),
        deleteDisabled: !canDeleteQueued(facts, message),
    } as const;
}

export function sessionPanePresentation(input: {
    readonly connection: SessionConnection;
    readonly projection: SessionProjection;
    readonly execution: SessionExecutionState;
    readonly interactions: Pick<SessionInteractionStore, "submissions">;
    readonly composer: Pick<SessionComposerStore, "draft">;
    readonly delivery: SessionDeliveryStore;
    readonly tasks: SessionTaskControlsStore;
    readonly queue: SessionMessageQueueStore;
    readonly attachments: ComposerAttachmentStore;
    readonly settings: Pick<SessionSettingsStore, "change">;
    readonly feedback: Pick<SessionOperationFeedbackStore, "failure">;
    readonly fork: Pick<SessionForkStore, "fork">;
    readonly connectionAvailable: boolean;
    readonly steeringSupported: boolean;
    readonly forkSupported: boolean;
}) {
    const { connection, execution, composer, attachments, feedback } = input;
    const delivery = settledDelivery(input.delivery, execution);
    const facts = sessionOperationFacts(input);
    const timeline = sessionProjectionTimeline(input.projection, execution.observations);
    const activity = sessionActivity(execution, delivery.state);
    // Which turn runs is the current turn's; the stop control only adds whether the user asked to stop it.
    const running = acceptedTurn(execution.turn);
    const controlRunning = running !== null;
    const stopping = facts.stopping;
    const composerInputDisabled =
        connection.kind === "closed" || facts.configuring || facts.waitingForInput || stopping;
    const unknownDelivery = unconfirmedJournal(delivery.state);
    const deliveries = sessionDeliveryPresentation(timeline.messages, execution, delivery, input.queue);
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
        connection.kind !== "closed" &&
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
        stopDisabled: !canStop(facts),
        forkDisabled: !canFork(facts),
        canSuggestProgress:
            !controlRunning &&
            canSend(facts) &&
            composer.draft.length === 0 &&
            attachments.attachments.length === 0 &&
            attachments.state.kind !== "reading",
        // Operations that failed because the Session closed say nothing the closed notice does not already say. The
        // Session's turn and its delivery are reported while they stay failed; otherwise the composer reports the last
        // operation that failed.
        composerError:
            connection.kind === "closed" || pendingDelivery?.error != null
                ? ""
                : ((activity.kind === "failed" && !hasFailureCard && authenticationFailure === null
                      ? // A turn failure belongs to its timeline card. Keep the composer fallback only when that
                        // command has no card.
                        activity.message
                      : null) ??
                  (delivery.state.kind === "failed" ? delivery.state.failure.message : null) ??
                  // A turn being stopped is not offered to stop again, so a stop failure no longer describes it.
                  operationFailureMessage(feedback.failure, stopping ? null : running, visibleQueue(execution)) ??
                  ""),
        deliveryUnknownUserMessageId: unknownDelivery?.commandId ?? null,
        hasOlderHistory: timeline.hasOlderHistory,
        historyLoading: sessionProjectionOlderHistory(input.projection).kind === "loading",
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
        retryFailedDisabled: pendingDelivery === null || !canRetryFailedMessage(facts),
        retryUnknownDeliveryDisabled: unknownDelivery === null || !canRetryUnknownDelivery(facts),
        removeUnknownDeliveryDisabled: !canRemoveUnknownDelivery(facts),
        submitDisabled:
            !composerHasMessage(composer.draft, attachments.attachments.length, attachments.state.kind === "reading") ||
            !canSend(facts),
        answerDisabled: !canSend(facts),
        ...deliveries,
        queuedMessages: deliveries.queuedMessages.map((message) => queuedMessagePresentation(facts, message)),
    } as const;
}
