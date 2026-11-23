import type { SessionConnection } from "./session-connection.ts";
import {
    type DeliveryState,
    deliveryTakesNewMessage,
    failedSubmission,
    unknownDelivery,
} from "./session-delivery-store.ts";
import type { ChatQueuedMessage } from "./session-message-queue-store.ts";

/**
 * The facts that decide which of the user's operations the Session pane accepts now. The presentation disables a
 * control and the action refuses through the same rule over the same facts, so the two cannot disagree.
 */
export interface SessionOperationFacts {
    readonly connectionAvailable: boolean;
    readonly connection: SessionConnection["kind"];
    /** The running turn is being stopped. */
    readonly stopping: boolean;
    readonly configuring: boolean;
    readonly delivery: DeliveryState;
    readonly waitingForInput: boolean;
    readonly ownerRunsTurn: boolean;
    readonly steeringSupported: boolean;
    readonly forkSupported: boolean;
    readonly forking: boolean;
    readonly turnRunning: boolean;
    readonly queued: boolean;
}

/** Settings changes and messages are serialized: a message waits while the Session's settings are changing. */
export function settingsAllowMessages(facts: Pick<SessionOperationFacts, "configuring">): boolean {
    return !facts.configuring;
}

/**
 * Whether the user can submit to the Session now: it is reachable and connected and its settings are not changing.
 * Which message may start is delivery's decision; whether it runs now or waits behind earlier work is the Computer's
 * admission, which never refuses a message.
 */
function userCanSubmit(facts: SessionOperationFacts): boolean {
    return (
        facts.connectionAvailable &&
        !facts.waitingForInput &&
        !facts.stopping &&
        // A message must not reach the Session before the fork the user already asked for copies it.
        !facts.forking &&
        facts.connection === "ready" &&
        settingsAllowMessages(facts)
    );
}

export function canSend(facts: SessionOperationFacts): boolean {
    return deliveryTakesNewMessage(facts.delivery) && userCanSubmit(facts);
}

export function canRetryFailedMessage(facts: SessionOperationFacts): boolean {
    return failedSubmission(facts.delivery) !== null && userCanSubmit(facts);
}

/**
 * Retrying a message whose delivery is unknown sends its request again under the same identity, so the Computer runs it
 * at most once. That unresolved delivery is the one this retry settles.
 */
export function canRetryUnknownDelivery(facts: SessionOperationFacts): boolean {
    return unknownDelivery(facts.delivery) !== null && userCanSubmit(facts);
}

/**
 * Removing a message whose delivery is unknown withdraws it on the Computer under its identity, so it never runs. Like
 * deleting a queued message, it needs the Session reachable.
 */
export function canRemoveUnknownDelivery(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "delivery">,
): boolean {
    return unknownDelivery(facts.delivery) !== null && facts.connectionAvailable && facts.connection === "ready";
}

/**
 * Changing the Session's settings. Settings have their own acknowledged operation, independent of prompt output and
 * permission requests: keep submission and stop boundaries stable and serialize edits.
 */
export function canChangeSettings(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "configuring" | "delivery" | "stopping">,
): boolean {
    return (
        facts.connectionAvailable &&
        facts.connection === "ready" &&
        !facts.configuring &&
        facts.delivery.kind === "idle" &&
        !facts.stopping
    );
}

/**
 * Stopping the running turn: the Session is reachable, the turn is Morty's to stop rather than its owner's, and it is
 * not already being stopped.
 */
export function canStop(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "ownerRunsTurn" | "stopping">,
): boolean {
    return facts.connectionAvailable && facts.connection === "ready" && !facts.ownerRunsTurn && !facts.stopping;
}

/**
 * Forking copies the Session as the user last saw it, so the Session must be at rest: nothing running, being sent,
 * queued or waiting for the user, and its connection ready to report a failure.
 */
export function canFork(facts: SessionOperationFacts): boolean {
    return (
        facts.forkSupported &&
        facts.connectionAvailable &&
        facts.connection === "ready" &&
        !facts.forking &&
        !facts.turnRunning &&
        !facts.queued &&
        !facts.stopping &&
        !facts.configuring &&
        !facts.waitingForInput &&
        facts.delivery.kind === "idle"
    );
}

function canActOnQueued(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection">,
    message: Pick<ChatQueuedMessage, "kind">,
): boolean {
    return facts.connectionAvailable && facts.connection === "ready" && message.kind === "queued";
}

export function canDeleteQueued(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection">,
    message: Pick<ChatQueuedMessage, "kind">,
): boolean {
    return canActOnQueued(facts, message);
}

export function queuedMessageEditable(message: Pick<ChatQueuedMessage, "prompt" | "attachments">): boolean {
    return (
        message.prompt !== "" || (message.attachments.kind === "restorable" && message.attachments.values.length > 0)
    );
}

export function canEditQueued(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection">,
    message: Pick<ChatQueuedMessage, "kind" | "prompt" | "attachments">,
): boolean {
    return canActOnQueued(facts, message) && queuedMessageEditable(message);
}

export function canSteerQueued(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "steeringSupported">,
    message: Pick<ChatQueuedMessage, "kind">,
): boolean {
    return facts.steeringSupported && canActOnQueued(facts, message);
}

/**
 * The queued message could steer but for the Session itself: the Runtime withdraws steering only from a Session another
 * process holds, as Codex on the computer does with its conversation.
 */
export function steeringWithheld(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "steeringSupported">,
    message: Pick<ChatQueuedMessage, "kind">,
): boolean {
    return !facts.steeringSupported && canActOnQueued(facts, message);
}

export function composerHasMessage(draft: string, attachmentCount: number, readingAttachments: boolean): boolean {
    return !readingAttachments && (draft.trim() !== "" || attachmentCount > 0);
}
