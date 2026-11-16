import type { SessionConnection } from "./session-connection.ts";
import type { SessionDeliveryStore } from "./session-delivery-store.ts";
import type { ChatQueuedMessage } from "./session-message-queue-store.ts";

/**
 * The facts that decide which of the user's operations the Session pane accepts now. The presentation disables a
 * control and the action refuses through the same rule over the same facts, so the two cannot disagree.
 */
export interface SessionOperationFacts {
    readonly connectionAvailable: boolean;
    readonly connection: SessionConnection["kind"];
    /** The user asked to stop the running turn. */
    readonly stopping: boolean;
    readonly configuring: boolean;
    readonly delivery: SessionDeliveryStore["state"]["kind"];
    readonly waitingForInput: boolean;
    readonly ownerRunsTurn: boolean;
    readonly steeringSupported: boolean;
}

/**
 * Whether the Session takes a message now: it is connected and its settings are not changing. Whether the message runs
 * now or waits behind earlier work is the Computer's admission, which never refuses a message.
 */
function sessionAccepts(facts: Pick<SessionOperationFacts, "connection" | "configuring">): boolean {
    return facts.connection === "ready" && !facts.configuring;
}

export function canSubmit(facts: Pick<SessionOperationFacts, "connection" | "configuring" | "delivery">): boolean {
    return (
        facts.delivery !== "preparing" &&
        facts.delivery !== "submitting" &&
        facts.delivery !== "delivery-unknown" &&
        sessionAccepts(facts)
    );
}

function userCanReachSession(facts: SessionOperationFacts): boolean {
    return facts.connectionAvailable && !facts.waitingForInput && !facts.stopping;
}

function userCanSubmit(facts: SessionOperationFacts): boolean {
    return userCanReachSession(facts) && canSubmit(facts);
}

export function canSend(facts: SessionOperationFacts): boolean {
    return facts.delivery === "idle" && userCanSubmit(facts);
}

export function canRetryFailedMessage(facts: SessionOperationFacts): boolean {
    return userCanSubmit(facts);
}

/**
 * Retrying a message whose delivery is unknown sends its request again under the same identity, so the Computer runs it
 * at most once. That unresolved delivery is the one this retry settles.
 */
export function canRetryUnknownDelivery(facts: SessionOperationFacts): boolean {
    return facts.delivery === "delivery-unknown" && userCanReachSession(facts) && sessionAccepts(facts);
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
        facts.delivery === "idle" &&
        !facts.stopping
    );
}

/** Stopping the running turn: the Session is reachable, and the turn is Morty's to stop rather than its owner's. */
export function canStop(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "ownerRunsTurn">,
): boolean {
    return facts.connectionAvailable && facts.connection === "ready" && !facts.ownerRunsTurn;
}

export function canStopFromSettings(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "ownerRunsTurn" | "stopping">,
): boolean {
    return canStop(facts) && !facts.stopping;
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

export function composerHasMessage(draft: string, attachmentCount: number, readingAttachments: boolean): boolean {
    return !readingAttachments && (draft.trim() !== "" || attachmentCount > 0);
}
