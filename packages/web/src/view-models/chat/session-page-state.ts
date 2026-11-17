import type { MortyClient, MortyInteractionResponseRequest } from "@portalcrew/morty-client";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import type { StoreApi } from "zustand/vanilla";
import {
    centralSessionStorage,
    elicitationAnswerDraftsEntry,
    SessionStorageWriteError,
    sessionPendingSubmissionEntry,
    sessionUnsentMessageEntry,
} from "../../services/session-storage/central-session-storage.ts";
import type { Clock } from "../../services/time/clock.ts";
import { createSessionComposerStore, type SessionComposerStore } from "./session-composer-store.ts";
import { createSessionDeliveryStore, type SessionDeliveryStore } from "./session-delivery-store.ts";
import { accountedInteractions, createSessionExecutionStore, type SessionExecutionStore } from "./session-execution.ts";
import { createSessionInteractionStore, type SessionInteractionStore } from "./session-interaction-store.ts";
import { createSessionMessageQueueStore, type SessionMessageQueueStore } from "./session-message-queue-store.ts";
import { createSessionOperationConnection, type SessionOperationConnection } from "./session-operation-connection.ts";
import {
    createSessionOperationFeedbackStore,
    type SessionOperationFeedbackStore,
} from "./session-operation-feedback.ts";
import { createSessionRenameStore, type SessionRenameStore } from "./session-rename-store.ts";
import { createSessionSettingsStore, type SessionSettingsStore } from "./session-settings-store.ts";
import { createSessionSubmission, type SessionSubmission } from "./session-submission.ts";
import { createSessionTaskControlsStore, type SessionTaskControlsStore } from "./session-task-controls.ts";
import { createUserMessageCollapseStore, type UserMessageCollapseStore } from "./user-message-collapse-store.ts";

/**
 * What the page holds for one Session, whichever pane shows it: the Session's execution as the Computer reported it,
 * what the user is writing, the messages the page submitted and how they are submitted, and what the user asked the
 * Session to do: its requests on the Computer's queue, a stop, a settings change, answers to the Agent and a confirmed
 * rename. A pane is replaced on every re-read or reconnection and only follows the Session's connection and timeline,
 * feeding what it observes into the execution state; this state lasts as long as the page, so no replacement resets a
 * Session fact or ends a Session operation.
 */
export interface SessionPageState {
    readonly userMessageCollapse: UserMessageCollapseStore;
    readonly lifetime: AbortSignal;
    readonly connection: SessionOperationConnection;
    readonly composer: StoreApi<SessionComposerStore>;
    readonly delivery: StoreApi<SessionDeliveryStore>;
    readonly execution: StoreApi<SessionExecutionStore>;
    readonly feedback: StoreApi<SessionOperationFeedbackStore>;
    readonly interactions: StoreApi<SessionInteractionStore>;
    readonly queue: StoreApi<SessionMessageQueueStore>;
    readonly rename: StoreApi<SessionRenameStore>;
    readonly settings: StoreApi<SessionSettingsStore>;
    readonly submission: SessionSubmission;
    readonly tasks: StoreApi<SessionTaskControlsStore>;
}

export function createSessionPageState(options: {
    readonly computerId: string;
    readonly sessionTarget: NativeSessionTarget;
    readonly clock: Clock;
    readonly refreshTitle: (signal: AbortSignal) => Promise<void>;
    readonly lifetime: AbortSignal;
}): SessionPageState {
    const { computerId, sessionTarget } = options;
    const unsentEntry = sessionUnsentMessageEntry(computerId, sessionTarget);
    const pendingEntry = sessionPendingSubmissionEntry(computerId, sessionTarget);
    // A message an earlier page left unsent returns to the composer; it is never delivered implicitly.
    const unsent = centralSessionStorage.read(unsentEntry);
    centralSessionStorage.remove(unsentEntry);
    const connection = createSessionOperationConnection();
    const feedback = createSessionOperationFeedbackStore();
    const { failed } = feedback.getState();
    const composer = createSessionComposerStore(computerId, sessionTarget, unsent);
    const delivery = createSessionDeliveryStore({
        lifetime: options.lifetime,
        pendingSubmission: centralSessionStorage.read(pendingEntry),
        pendingSubmissionChanged: (journal) => {
            if (journal === null) {
                centralSessionStorage.remove(pendingEntry);
            } else if (!centralSessionStorage.write(pendingEntry, journal)) {
                throw new SessionStorageWriteError();
            }
        },
        unsentMessageChanged: (content) => {
            if (content === null) {
                centralSessionStorage.remove(unsentEntry);
            } else {
                centralSessionStorage.write(unsentEntry, content);
            }
        },
        runtime: () => execution.getState().state,
    });
    const tasks = createSessionTaskControlsStore({ clock: options.clock, sessionTarget, connection, failed });
    const queue = createSessionMessageQueueStore({
        sessionTarget,
        connection,
        failed,
        answered: (answer) => {
            execution.getState().apply(answer);
        },
        returned: (message) => {
            // The queued message was written first, so it goes ahead of a draft the user started since.
            feedback.getState().dismiss();
            composer
                .getState()
                .returnMessage(
                    message.prompt,
                    message.attachments.kind === "unrestorable" && message.attachments.count > 0,
                    message.attachments.kind === "restorable" ? message.attachments.values : [],
                );
        },
    });
    const respond = async (
        interactionId: string,
        request: MortyInteractionResponseRequest,
        signal: AbortSignal,
    ): Promise<void> => {
        await connection.send(
            (client: MortyClient, requestSignal) =>
                client.interactions.respond(sessionTarget, interactionId, request, requestSignal),
            AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        );
    };
    const answerDraftsEntry = elicitationAnswerDraftsEntry(computerId, sessionTarget);
    const interactions = createSessionInteractionStore({
        permission: (response, signal) =>
            respond(response.interactionId, { kind: "permission", answer: response.answer }, signal),
        elicitation: (response, signal) =>
            respond(response.interactionId, { kind: "elicitation", answer: response.answer }, signal),
        answerDrafts: new Map(Object.entries(centralSessionStorage.read(answerDraftsEntry) ?? {})),
        answerDraftsChanged: (drafts) => {
            if (drafts.size === 0) {
                centralSessionStorage.remove(answerDraftsEntry);
            } else {
                centralSessionStorage.write(answerDraftsEntry, Object.fromEntries(drafts));
            }
        },
        interactions: () => accountedInteractions(execution.getState().state),
    });
    const execution = createSessionExecutionStore();
    const settings = createSessionSettingsStore({ computerId, sessionTarget, connection, failed });
    return {
        userMessageCollapse: createUserMessageCollapseStore(),
        lifetime: options.lifetime,
        connection,
        composer,
        delivery,
        execution,
        feedback,
        interactions,
        queue,
        rename: createSessionRenameStore({ sessionTarget, connection, refreshTitle: options.refreshTitle, failed }),
        settings,
        submission: createSessionSubmission({ sessionTarget, connection, composer, delivery, execution, settings }),
        tasks,
    };
}
