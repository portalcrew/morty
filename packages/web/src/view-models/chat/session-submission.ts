import type { MortyClient, MortyTurnAdmission } from "@portalcrew/morty-client";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";
import { uploadPromptAttachments } from "./prompt-attachment-upload.ts";
import type { SessionComposerStore } from "./session-composer-store.ts";
import {
    type DeliveryAttempt,
    type SessionDeliveryStore,
    type StartedDelivery,
    SubmissionNotSentError,
    type SubmitTurn,
} from "./session-delivery-store.ts";
import type { SessionExecutionStore } from "./session-execution.ts";
import type { SessionOperationConnection } from "./session-operation-connection.ts";
import { composerHasMessage, settingsAllowMessages } from "./session-operation-rules.ts";
import { type SessionSettingsStore, settingsChanging } from "./session-settings-store.ts";

/**
 * The messages this page submits to the Session and how a submission recovers. The attempt belongs to the Session,
 * not to the pane showing it, so replacing the pane neither ends it nor loses its outcome: it waits for the next
 * pane's connection like every other operation of the Session. Delivery decides which message may start from its
 * state; nothing is submitted while the Session's settings are changing. Each operation that submits a message returns
 * the submission in flight, or null when it submitted nothing.
 */
export interface SessionSubmission {
    readonly sendDraft: () => Promise<void> | null;
    readonly sendAnswer: (answer: string) => Promise<void> | null;
    readonly sendAwaiting: () => Promise<void> | null;
    readonly retryFailed: () => Promise<void> | null;
    readonly retryUnknown: () => Promise<void> | null;
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
    const submit: SubmitTurn = async (request, signal) => {
        const { standing, position } = await submitThroughConnection(request, signal);
        signal.throwIfAborted();
        execution.getState().apply({ kind: "answered", commandId: request.idempotencyKey, answer: standing, position });
    };
    const attempt: DeliveryAttempt = {
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
        submit,
    };
    const settingsSettled = (): boolean =>
        settingsAllowMessages({ configuring: settingsChanging(settings.getState()) });
    const began = (started: StartedDelivery): Promise<void> => {
        // A new turn retires the failure reported for an earlier one.
        if (started.placement === "turn") {
            execution.getState().apply({ kind: "turn-submitted" });
        }
        return started.delivered;
    };
    const start = (startDelivery: () => StartedDelivery | null): Promise<void> | null => {
        if (!settingsSettled()) {
            return null;
        }
        const started = startDelivery();
        if (started === null) {
            return null;
        }
        composer.getState().questionsClosed();
        return began(started);
    };
    const startNew = (content: string, attachments: readonly ComposerAttachment[]): Promise<void> | null =>
        start(() =>
            delivery
                .getState()
                .send(
                    { commandId: crypto.randomUUID(), content, attachments: { kind: "local", values: attachments } },
                    attempt,
                ),
        );

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
        sendAwaiting: () => start(() => delivery.getState().sendAwaiting(attempt)),
        retryFailed: () => start(() => delivery.getState().retryFailed(attempt)),
        retryUnknown: () => {
            const started = settingsSettled() ? delivery.getState().retryUnknown(submit) : null;
            return started === null ? null : began(started);
        },
    };
}
