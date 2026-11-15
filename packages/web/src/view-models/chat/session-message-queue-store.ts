import type { MortyClient } from "@morty-build/client";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { formatError } from "../format-error.ts";
import { isAuthoritativeFailure, type SubmittedMessage } from "./session-delivery-store.ts";
import type { QueuedCommand } from "./session-execution.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";

type QueuedMessageAttachments =
    | { readonly kind: "restorable"; readonly values: readonly ComposerAttachment[] }
    | { readonly kind: "unrestorable"; readonly count: number };

interface QueuedMessageValue {
    readonly commandId: string;
    readonly attachments: QueuedMessageAttachments;
    readonly prompt: string;
    readonly summary: string;
}

export type ChatQueuedMessage =
    | ({ readonly kind: "queued" } & QueuedMessageValue)
    | ({ readonly kind: "steering" } & QueuedMessageValue)
    | ({ readonly kind: "deleting" } & QueuedMessageValue);

type QueueFeedback =
    | { readonly kind: "none" }
    | {
          readonly kind: "failed";
          readonly operation: "delete" | "steer";
          readonly commandId: string;
          readonly message: string;
      };

/** A withdrawn message stays hidden, whatever a read that began before its withdrawal still lists. */
type QueuedMessageRequest = "steering" | "deleting" | "withdrawn";

/**
 * How a request on the queue ended: the Computer did it, refused it, never received it, or may have done it without
 * confirming.
 */
type QueueRequestOutcome =
    | { readonly kind: "done" }
    | { readonly kind: "refused"; readonly cause: unknown }
    | { readonly kind: "unsent"; readonly cause: unknown }
    | { readonly kind: "unconfirmed"; readonly cause: unknown };

/**
 * The Session's requests on the Computer's queue. They run on the Session's operations, so switching panes neither ends
 * a request nor loses what it returns. Original files remain owned by delivery.
 */
export interface SessionMessageQueueStore {
    readonly feedback: QueueFeedback;
    readonly requests: ReadonlyMap<string, QueuedMessageRequest>;
    readonly deleteMessage: (message: ChatQueuedMessage, signal: AbortSignal) => Promise<void>;
    /**
     * Takes a queued message out of the queue and back into the composer for editing. The text returns whenever the
     * Computer may have withdrawn the message, so a withdrawal it did not confirm never loses the text.
     */
    readonly editMessage: (message: ChatQueuedMessage, signal: AbortSignal) => Promise<void>;
    readonly dismissFailure: () => void;
    /** Resolves whether the Computer took the message into the running turn. */
    readonly steerMessage: (message: ChatQueuedMessage, signal: AbortSignal) => Promise<boolean>;
}

/**
 * The failure of the user's last request on the queue. A failure to steer a message says nothing once the message has
 * left the Computer's `queued` messages.
 */
export function queueFailure(
    queue: Pick<SessionMessageQueueStore, "feedback">,
    queued: readonly QueuedCommand[],
): string | null {
    const { feedback } = queue;
    if (feedback.kind !== "failed") {
        return null;
    }
    return feedback.operation === "steer" && !queued.some((message) => message.commandId === feedback.commandId)
        ? null
        : feedback.message;
}

/** The Computer's queue, enriched from the Session's sole copy of local submitted messages. */
export function queuedMessages(
    queued: readonly QueuedCommand[],
    queue: Pick<SessionMessageQueueStore, "requests">,
    submitted: readonly SubmittedMessage[],
): readonly ChatQueuedMessage[] {
    return queued.flatMap((message): readonly ChatQueuedMessage[] => {
        const request = queue.requests.get(message.commandId);
        if (request === "withdrawn") {
            return [];
        }
        const local = submitted.find((candidate) => candidate.commandId === message.commandId)?.attachments;
        const attachments = local?.kind === "local" ? local.values : undefined;
        return [
            {
                commandId: message.commandId,
                summary: message.prompt || attachments?.map((attachment) => attachment.name).join(", ") || "",
                prompt: message.prompt,
                attachments:
                    attachments === undefined
                        ? { kind: "unrestorable", count: message.attachments.length }
                        : { kind: "restorable", values: attachments },
                kind: request ?? "queued",
            },
        ];
    });
}

function withRequest(
    requests: ReadonlyMap<string, QueuedMessageRequest>,
    commandId: string,
    request: QueuedMessageRequest | null,
): ReadonlyMap<string, QueuedMessageRequest> {
    const next = new Map(requests);
    if (request === null) {
        next.delete(commandId);
    } else {
        next.set(commandId, request);
    }
    return next;
}

export const createSessionMessageQueueStore = (options: {
    readonly sessionTarget: NativeSessionTarget;
    readonly connection: SessionOperationConnection;
    /** The Computer confirmed it withdrew a message. */
    readonly withdrawn: (commandId: string) => void;
    /** A message taken back for editing returns to the Session's composer. */
    readonly returned: (message: ChatQueuedMessage) => void;
}) =>
    createStore<SessionMessageQueueStore>()((set, get) => {
        /** Marks `message` with `request` while the Computer handles it, unless a request on it already runs. */
        const begin = (message: ChatQueuedMessage, request: "steering" | "deleting"): boolean => {
            if (get().requests.has(message.commandId)) {
                return false;
            }
            set((state) => ({
                feedback: { kind: "none" },
                requests: withRequest(state.requests, message.commandId, request),
            }));
            return true;
        };
        /** The message left the queue at the user's request; it stays hidden from then on. */
        const left = (commandId: string): void => {
            set((state) => ({ requests: withRequest(state.requests, commandId, "withdrawn") }));
        };
        /** Sends a request on the queue within its own budget, through whichever pane follows the Session. */
        const send = async (
            request: (client: MortyClient, signal: AbortSignal) => Promise<unknown>,
            parent: AbortSignal,
        ): Promise<QueueRequestOutcome> => {
            const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
            let sent = false;
            try {
                await options.connection.send(async (client, requestSignal) => {
                    sent = true;
                    await request(client, requestSignal);
                }, signal);
                signal.throwIfAborted();
                return { kind: "done" };
            } catch (cause) {
                parent.throwIfAborted();
                if (!sent) {
                    return { kind: "unsent", cause };
                }
                return isAuthoritativeFailure(cause) ? { kind: "refused", cause } : { kind: "unconfirmed", cause };
            }
        };
        const withdraw = async (message: ChatQueuedMessage, signal: AbortSignal): Promise<QueueRequestOutcome> => {
            const { commandId } = message;
            const outcome = await send(
                (client, requestSignal) => client.turns.cancelQueued(options.sessionTarget, commandId, requestSignal),
                signal,
            );
            if (outcome.kind === "done") {
                left(commandId);
                options.withdrawn(commandId);
                return outcome;
            }
            // The message shows again for as long as the Computer's queue lists it.
            set((state) => ({
                feedback: {
                    kind: "failed",
                    operation: "delete",
                    commandId,
                    message: formatError(outcome.cause, "The queued message could not be deleted."),
                },
                requests: withRequest(state.requests, commandId, null),
            }));
            return outcome;
        };
        return {
            feedback: { kind: "none" },
            requests: new Map(),
            deleteMessage: async (message, signal) => {
                if (begin(message, "deleting")) {
                    await withdraw(message, signal);
                }
            },
            editMessage: async (message, signal) => {
                if (!begin(message, "deleting")) {
                    return;
                }
                const outcome = await withdraw(message, signal);
                switch (outcome.kind) {
                    case "done":
                        options.returned(message);
                        return;
                    case "unconfirmed":
                        options.returned(message);
                        set({
                            feedback: {
                                kind: "failed",
                                operation: "delete",
                                commandId: message.commandId,
                                message:
                                    "Removing the message from the queue was not confirmed. Its text is back in the composer; delete it from the queue if it is still there.",
                            },
                        });
                        return;
                    case "refused":
                    case "unsent":
                        return;
                    default:
                        return outcome satisfies never;
                }
            },
            dismissFailure: () => set({ feedback: { kind: "none" } }),
            steerMessage: async (message, signal) => {
                if (!begin(message, "steering")) {
                    return false;
                }
                const { commandId } = message;
                const outcome = await send(
                    (client, requestSignal) => client.turns.steer(options.sessionTarget, commandId, requestSignal),
                    signal,
                );
                if (outcome.kind === "done") {
                    left(commandId);
                    return true;
                }
                // Execution events and queue reads may show the message gone before the HTTP refusal arrives, which
                // `queueFailure` then leaves unreported.
                set((state) => ({
                    feedback: {
                        kind: "failed",
                        operation: "steer",
                        commandId,
                        message: formatError(outcome.cause, "The queued message could not steer the task."),
                    },
                    requests: withRequest(state.requests, commandId, null),
                }));
                return false;
            },
        };
    });
