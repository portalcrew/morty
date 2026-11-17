import type { MortyClient, MortyTurnAdmission } from "@portalcrew/morty-client";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { uploadPromptAttachments } from "./prompt-attachment-upload.ts";
import type { SessionComposerStore } from "./session-composer-store.ts";
import {
    awaitingMessage,
    type DeliveryPlacement,
    journalMessage,
    type SessionDeliveryStore,
    SubmissionNotSentError,
    type SubmitTurn,
    type SubmittedMessage,
    settledDelivery,
} from "./session-delivery-store.ts";
import type { SessionExecutionStore } from "./session-execution.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";
import { canStartSubmission, composerHasMessage } from "./session-operation-rules.ts";
import type { SessionSettingsStore } from "./session-settings-store.ts";

/**
 * The messages this page submits to the Session and how a submission recovers. The attempt belongs to the Session,
 * not to the pane showing it, so replacing the pane neither ends it nor loses its outcome: it waits for the next
 * pane's connection like every other operation of the Session. A message is submitted only while no earlier one is in
 * flight or unconfirmed and the Session's settings are not changing. Each operation that submits a message returns
 * the submission in flight, or null when it submitted nothing.
 */
export interface SessionSubmission {
    readonly sendDraft: () => Promise<void> | null;
    readonly sendAnswer: (answer: string) => Promise<void> | null;
    readonly sendAwaiting: () => Promise<void> | null;
    /**
     * Submits a message that failed again: one the Computer never received keeps its identity, one it rejected gets a
     * new identity.
     */
    readonly retryFailed: () => Promise<void> | null;
    /** Sends an unconfirmed message again under its identity, so the Computer runs it at most once. */
    readonly retryUnknown: () => Promise<void>;
}

export function createSessionSubmission(ports: {
    readonly sessionTarget: NativeSessionTarget;
    readonly connection: SessionOperationConnection;
    readonly composer: StoreApi<SessionComposerStore>;
    readonly delivery: StoreApi<SessionDeliveryStore>;
    readonly execution: StoreApi<SessionExecutionStore>;
    readonly settings: StoreApi<SessionSettingsStore>;
}): SessionSubmission {
    const { sessionTarget, connection, composer, delivery, execution, settings } = ports;
    const settledState = () => settledDelivery(delivery.getState(), execution.getState().state).state;
    const configuring = (): boolean => settings.getState().change.kind === "configuring";

    const submitThroughConnection = async (
        request: Parameters<SubmitTurn>[0],
        signal: AbortSignal,
    ): Promise<MortyTurnAdmission> => {
        let sent = false;
        try {
            return await connection.send((client: MortyClient, requestSignal) => {
                sent = true;
                return client.turns.submit(sessionTarget, request, requestSignal);
            }, signal);
        } catch (cause) {
            if (sent || signal.aborted) {
                throw cause;
            }
            throw new SubmissionNotSentError({ cause });
        }
    };
    const submitCommand =
        (commandId: string): SubmitTurn =>
        async (request, signal) => {
            const { standing, position } = await submitThroughConnection(request, signal);
            signal.throwIfAborted();
            execution.getState().apply({ kind: "answered", commandId, answer: standing, position });
        };
    // A new turn retires the failure reported for an earlier one.
    const begin = (placement: DeliveryPlacement): void => {
        if (placement === "turn") {
            execution.getState().apply({ kind: "turn-submitted" });
        }
    };
    const start = (submitted: Omit<SubmittedMessage, "placement">): Promise<void> | null => {
        if (!canStartSubmission({ configuring: configuring(), delivery: settledState().kind })) {
            return null;
        }
        // Shown in the queue while a turn runs, otherwise as the next turn, until the Computer says which it is.
        const placement: DeliveryPlacement = execution.getState().state.turn.kind === "current" ? "queue" : "turn";
        const sending = delivery.getState().send(
            { ...submitted, placement },
            {
                prepare: async ({ attachments, content }, signal) => {
                    const uploaded =
                        attachments.kind === "uploaded"
                            ? attachments.values
                            : await connection.send(
                                  (client, requestSignal) =>
                                      uploadPromptAttachments(
                                          client.sessions,
                                          sessionTarget,
                                          attachments.values,
                                          requestSignal,
                                      ),
                                  signal,
                              );
                    // Freeze semantic intent before delivery owns retries, including identity.
                    return { attachments: uploaded, content: content.trim() };
                },
                submit: submitCommand(submitted.commandId),
            },
        );
        composer.getState().questionsClosed();
        begin(placement);
        return sending;
    };
    const startNew = (content: string, attachments: readonly ComposerAttachment[]): Promise<void> | null =>
        start({ commandId: crypto.randomUUID(), content, attachments: { kind: "local", values: attachments } });

    return {
        sendDraft: () => {
            const { attachments, state } = composer.getState().attachments.getState();
            const { draft } = composer.getState();
            if (!composerHasMessage(draft, attachments.length, state.kind === "reading")) {
                return null;
            }
            const sending = startNew(draft, attachments);
            if (sending !== null) {
                composer.getState().sent();
            }
            return sending;
        },
        sendAnswer: (answer) => startNew(answer, []),
        sendAwaiting: () => {
            const message = awaitingMessage(delivery.getState().state);
            return message === null ? null : start(message);
        },
        retryFailed: () => {
            const { state } = delivery.getState();
            switch (state.kind) {
                case "preparation-failed":
                    // Nothing reached the Computer, so the message keeps its identity.
                    return start(state.message);
                case "failed":
                    return start({ ...journalMessage(state.journal), commandId: crypto.randomUUID() });
                case "idle":
                case "awaiting-connection":
                case "preparing":
                case "submitting":
                case "delivery-unknown":
                case "withdrawing":
                    return null;
                default:
                    return state satisfies never;
            }
        },
        retryUnknown: async () => {
            const state = settledState();
            if (state.kind !== "delivery-unknown" || configuring()) {
                return;
            }
            const { commandId, placement } = state.journal;
            begin(placement);
            await delivery.getState().retry(submitCommand(commandId));
        },
    };
}
