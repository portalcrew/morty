import type { MortyClient, MortyQueuedTurnChange } from "@portalcrew/morty-client";
import type { NativeSessionTarget, SessionLogPosition } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { formatError } from "../format-error.ts";
import { type AcceptedMessage, isAuthoritativeFailure } from "./session-delivery-store.ts";
import type { CommandAnswered, QueuedCommand } from "./session-execution.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";
import type { OperationFailure } from "./session-operation-feedback.ts";

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

type QueuedMessageRequest = "steering" | "deleting";

/**
 * How a request on the queue ended: the Computer did it, refused it, never received it, or may have done it without
 * confirming.
 */
type QueueRequestOutcome =
    | { readonly kind: "done"; readonly position: SessionLogPosition }
    | { readonly kind: "refused"; readonly cause: unknown }
    | { readonly kind: "unsent"; readonly cause: unknown }
    | { readonly kind: "unconfirmed"; readonly cause: unknown };

/**
 * The Session's requests on the Computer's queue. They run on the Session's operations, so switching panes neither ends
 * a request nor loses what it returns. The Computer's answer to a request enters the Session's execution, which orders
 * it against the queue it lists. A failed request reports its failure to the Session's operation feedback.
 * Original files remain owned by delivery, which releases them once the Computer's account no longer lists the message.
 */
export interface SessionMessageQueueStore {
    readonly requests: ReadonlyMap<string, QueuedMessageRequest>;
    readonly deleteMessage: (message: ChatQueuedMessage, signal: AbortSignal) => Promise<void>;
    /**
     * Takes a queued message out of the queue and back into the composer for editing. The text returns whenever the
     * Computer may have withdrawn the message, so a withdrawal it did not confirm never loses the text.
     */
    readonly editMessage: (message: ChatQueuedMessage, signal: AbortSignal) => Promise<void>;
    readonly steerMessage: (message: ChatQueuedMessage, signal: AbortSignal) => Promise<boolean>;
    /**
     * Withdraws a message whose delivery is unconfirmed, as a queued one is deleted: the Computer withdraws it if
     * queued, and reserves an identity it has not seen so the message never runs. True when the Computer withdrew it.
     */
    readonly withdrawUnconfirmed: (commandId: string, signal: AbortSignal) => Promise<boolean>;
}

export function queuedMessages(
    queued: readonly QueuedCommand[],
    queue: Pick<SessionMessageQueueStore, "requests">,
    submitted: readonly AcceptedMessage[],
): readonly ChatQueuedMessage[] {
    return queued.flatMap((message): readonly ChatQueuedMessage[] => {
        const request = queue.requests.get(message.commandId);
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
    readonly returned: (message: ChatQueuedMessage) => void;
    readonly failed: (failure: OperationFailure) => void;
    readonly answered: (answer: CommandAnswered) => void;
}) =>
    createStore<SessionMessageQueueStore>()((set, get) => {
        const begin = (message: ChatQueuedMessage, request: "steering" | "deleting"): boolean => {
            if (get().requests.has(message.commandId)) {
                return false;
            }
            set((state) => ({ requests: withRequest(state.requests, message.commandId, request) }));
            return true;
        };
        const left = (commandId: string, answer: "withdrawn" | "steered", position: SessionLogPosition): void => {
            options.answered({ kind: "answered", commandId, answer: { state: answer }, position });
            set((state) => ({ requests: withRequest(state.requests, commandId, null) }));
        };
        const send = async (
            request: (client: MortyClient, signal: AbortSignal) => Promise<MortyQueuedTurnChange>,
            parent: AbortSignal,
        ): Promise<QueueRequestOutcome> => {
            const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
            let sent = false;
            try {
                const { position } = await options.connection.send(async (client, requestSignal) => {
                    sent = true;
                    return await request(client, requestSignal);
                }, signal);
                signal.throwIfAborted();
                return { kind: "done", position };
            } catch (cause) {
                parent.throwIfAborted();
                if (!sent) {
                    return { kind: "unsent", cause };
                }
                return isAuthoritativeFailure(cause) ? { kind: "refused", cause } : { kind: "unconfirmed", cause };
            }
        };
        const withdraw = async (
            commandId: string,
            failure: { readonly operation: "delete-queued" | "remove-unconfirmed"; readonly fallback: string },
            signal: AbortSignal,
        ): Promise<QueueRequestOutcome> => {
            const outcome = await send(
                (client, requestSignal) => client.turns.cancelQueued(options.sessionTarget, commandId, requestSignal),
                signal,
            );
            if (outcome.kind === "done") {
                left(commandId, "withdrawn", outcome.position);
                return outcome;
            }
            set((state) => ({ requests: withRequest(state.requests, commandId, null) }));
            options.failed({ operation: failure.operation, message: formatError(outcome.cause, failure.fallback) });
            return outcome;
        };
        const deleteQueued = (message: ChatQueuedMessage, signal: AbortSignal): Promise<QueueRequestOutcome> =>
            withdraw(
                message.commandId,
                { operation: "delete-queued", fallback: "The queued message could not be deleted." },
                signal,
            );
        return {
            requests: new Map(),
            deleteMessage: async (message, signal) => {
                if (begin(message, "deleting")) {
                    await deleteQueued(message, signal);
                }
            },
            editMessage: async (message, signal) => {
                if (!begin(message, "deleting")) {
                    return;
                }
                const outcome = await deleteQueued(message, signal);
                switch (outcome.kind) {
                    case "done":
                        options.returned(message);
                        return;
                    case "unconfirmed":
                        options.returned(message);
                        options.failed({
                            operation: "delete-queued",
                            message:
                                "Removing the message from the queue was not confirmed. Its text is back in the composer; delete it from the queue if it is still there.",
                        });
                        return;
                    case "refused":
                    case "unsent":
                        return;
                    default:
                        return outcome satisfies never;
                }
            },
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
                    left(commandId, "steered", outcome.position);
                    return true;
                }
                // Execution events and queue reads may show the message gone before the HTTP refusal arrives; the failure
                // then says nothing, since it describes the message only while the Computer queues it.
                set((state) => ({ requests: withRequest(state.requests, commandId, null) }));
                options.failed({
                    operation: "steer",
                    commandId,
                    message: formatError(outcome.cause, "The queued message could not steer the task."),
                });
                return false;
            },
            withdrawUnconfirmed: async (commandId, signal) =>
                (
                    await withdraw(
                        commandId,
                        { operation: "remove-unconfirmed", fallback: "The message could not be removed." },
                        signal,
                    )
                ).kind === "done",
        };
    });
