import {
    type AcceptedMessage,
    type DeliveryPlacement,
    type DeliveryRecord,
    type DeliveryState,
    deliveryMessagePresentation,
    deliveryMessages,
    journalMessage,
    type SubmittedMessage,
} from "./session-delivery-store.ts";
import { acceptedPlacement, type SessionExecutionState, visibleQueue } from "./session-execution.ts";
import { queuedMessages, type SessionMessageQueueStore } from "./session-message-queue-store.ts";
import { type SessionExecutionMessage, sessionUserCommandIds } from "./session-presentation.ts";

type LocalMessage =
    | { readonly kind: "awaiting" | "unknown"; readonly message: SubmittedMessage }
    | { readonly kind: "accepted"; readonly message: AcceptedMessage; readonly placement: DeliveryPlacement }
    | { readonly kind: "pending"; readonly message: SubmittedMessage; readonly error: string | null };

function localPlacement(entry: LocalMessage): DeliveryPlacement {
    return entry.kind === "accepted" ? entry.placement : entry.message.placement;
}

function currentMessage(state: DeliveryState): LocalMessage | null {
    switch (state.kind) {
        case "idle":
            return null;
        case "awaiting-connection":
            return { kind: "awaiting", message: state.message };
        case "preparing":
            return { kind: "pending", message: state.message, error: null };
        case "preparation-failed":
            return { kind: "pending", message: state.message, error: state.failure.message };
        case "submitting":
            return { kind: "pending", message: journalMessage(state.journal), error: null };
        case "failed":
            return { kind: "pending", message: journalMessage(state.journal), error: state.failure.message };
        case "delivery-unknown":
        case "withdrawing":
            return { kind: "unknown", message: journalMessage(state.journal) };
        default:
            return state satisfies never;
    }
}

/**
 * History, then the Computer queue, then local delivery own each command's sole display location. The settled
 * delivery holds only the accepted messages the Computer's account does not cover yet.
 */
export function sessionDeliveryPresentation(
    messages: readonly SessionExecutionMessage[],
    execution: SessionExecutionState,
    delivery: DeliveryRecord,
    queue: Pick<SessionMessageQueueStore, "requests">,
) {
    const queued = visibleQueue(execution);
    const historyIds = new Set(sessionUserCommandIds(messages));
    const claimed = new Set([...historyIds, ...queued.map((message) => message.commandId)]);
    const current = currentMessage(delivery.state);
    const candidates: readonly LocalMessage[] = [
        ...(current === null ? [] : [current]),
        ...delivery.accepted.map(
            (message): LocalMessage => ({
                kind: "accepted",
                message,
                placement: acceptedPlacement(execution, message.commandId),
            }),
        ),
    ];
    const local = candidates.filter(({ message }) => {
        if (claimed.has(message.commandId)) {
            return false;
        }
        claimed.add(message.commandId);
        return true;
    });
    const pendingQueue = local.filter(
        (entry) =>
            localPlacement(entry) === "queue" &&
            (entry.kind === "accepted" || (entry.kind === "pending" && entry.error === null)),
    );
    const timeline = local.filter((entry) => !pendingQueue.includes(entry));
    const awaiting = timeline.find((message) => message.kind === "awaiting");
    const unknown = timeline.find((message) => message.kind === "unknown");
    const pending = timeline.find((message) => message.kind === "pending");
    return {
        awaitingMessage: awaiting === undefined ? null : deliveryMessagePresentation(awaiting.message),
        unconfirmedDelivery: unknown === undefined ? null : deliveryMessagePresentation(unknown.message),
        pendingDelivery:
            pending === undefined
                ? null
                : {
                      message: deliveryMessagePresentation(pending.message),
                      sending: pending.error === null,
                      error: pending.error,
                  },
        confirmedMessages: timeline
            .filter((message) => message.kind === "accepted")
            .map(({ message }) => deliveryMessagePresentation(message)),
        pendingQueueMessages: pendingQueue.map((entry) => ({
            commandId: entry.message.commandId,
            summary: deliveryMessagePresentation(entry.message).displayPrompt,
            status: entry.kind === "accepted" ? "Message queued" : "Sending message",
        })),
        queuedMessages: queuedMessages(
            queued.filter((message) => !historyIds.has(message.commandId)),
            queue,
            deliveryMessages(delivery),
        ),
    };
}
