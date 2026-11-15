import type { SessionConnection } from "./session-connection.ts";
import type { SessionDeliveryStore } from "./session-delivery-store.ts";
import type { ChatQueuedMessage } from "./session-message-queue-store.ts";

/**
 * The facts that decide which of the user's operations the Session pane accepts now. The presentation disables a
 * control and the action refuses through the same rule over the same facts, so the two cannot disagree.
 */
export interface SessionOperationFacts {
    /** The network, the Computer and this Session's stream are all available, as the connection header reports. */
    readonly connectionAvailable: boolean;
    readonly connection: SessionConnection["kind"];
    /** The user asked to stop the running turn. */
    readonly stopping: boolean;
    /** A change to the Session's settings is in flight. */
    readonly configuring: boolean;
    readonly delivery: SessionDeliveryStore["state"]["kind"];
    /** The Agent waits for the user's answer to a permission request or question. */
    readonly waitingForInput: boolean;
    /** The running turn belongs to the native session's owner, such as the Codex app, which only it can stop. */
    readonly ownerRunsTurn: boolean;
    /** The Session's Agent lets a queued message steer the running turn. */
    readonly steeringSupported: boolean;
}

/**
 * Whether the Session takes a message now: it is connected and its settings are not changing. Whether the message runs
 * now or waits behind earlier work is the Computer's admission, which never refuses a message.
 */
function sessionAccepts(facts: Pick<SessionOperationFacts, "connection" | "configuring">): boolean {
    return facts.connection === "ready" && !facts.configuring;
}

/**
 * Whether delivery can take a message now: the Session accepts it, with no earlier submission being prepared,
 * submitted or unresolved.
 */
export function canSubmit(facts: Pick<SessionOperationFacts, "connection" | "configuring" | "delivery">): boolean {
    return (
        facts.delivery !== "preparing" &&
        facts.delivery !== "submitting" &&
        facts.delivery !== "delivery-unknown" &&
        sessionAccepts(facts)
    );
}

/**
 * What the user's submissions also need: a reachable Computer, no question awaiting the user's answer, and no stop the
 * user is still waiting on, during which the composer is locked.
 */
function userCanReachSession(facts: SessionOperationFacts): boolean {
    return facts.connectionAvailable && !facts.waitingForInput && !facts.stopping;
}

/** A submission the user makes, which delivery takes as a new submission. */
function userCanSubmit(facts: SessionOperationFacts): boolean {
    return userCanReachSession(facts) && canSubmit(facts);
}

/** Sending the composer's message, which the Computer runs or queues. One message is in delivery at a time. */
export function canSend(facts: SessionOperationFacts): boolean {
    return facts.delivery === "idle" && userCanSubmit(facts);
}

/** Retrying a failed message submits it again under a new identity. */
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

/** Stopping from the settings notice, which also waits out a stop the user already asked for. */
export function canStopFromSettings(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "ownerRunsTurn" | "stopping">,
): boolean {
    return canStop(facts) && !facts.stopping;
}

/**
 * Acting on a message in the Computer's queue: the Computer is reachable, and no other request on that message is in
 * flight. Queue requests are independent of delivery, settings and stopping.
 */
function canActOnQueued(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection">,
    message: Pick<ChatQueuedMessage, "kind">,
): boolean {
    return facts.connectionAvailable && facts.connection === "ready" && message.kind === "queued";
}

/** Deleting a queued message withdraws it from the Computer's queue. */
export function canDeleteQueued(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection">,
    message: Pick<ChatQueuedMessage, "kind">,
): boolean {
    return canActOnQueued(facts, message);
}

/** A queued message returns to the composer only with something to edit: its text, or files this browser still holds. */
export function queuedMessageEditable(message: Pick<ChatQueuedMessage, "prompt" | "attachments">): boolean {
    return (
        message.prompt !== "" || (message.attachments.kind === "restorable" && message.attachments.values.length > 0)
    );
}

/** Editing a queued message withdraws it and returns it to the composer. */
export function canEditQueued(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection">,
    message: Pick<ChatQueuedMessage, "kind" | "prompt" | "attachments">,
): boolean {
    return canActOnQueued(facts, message) && queuedMessageEditable(message);
}

/** Steering moves a queued message into the running turn, which only an Agent that supports steering accepts. */
export function canSteerQueued(
    facts: Pick<SessionOperationFacts, "connectionAvailable" | "connection" | "steeringSupported">,
    message: Pick<ChatQueuedMessage, "kind">,
): boolean {
    return facts.steeringSupported && canActOnQueued(facts, message);
}

/** The composer holds a message to send or queue: text or files, with no file still being read. */
export function composerHasMessage(draft: string, attachmentCount: number, readingAttachments: boolean): boolean {
    return !readingAttachments && (draft.trim() !== "" || attachmentCount > 0);
}
