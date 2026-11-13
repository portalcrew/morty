import type { MortyClient, MortyInteractionResponseRequest } from "@morty-build/client";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
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
import { createSessionExecutionStore, pendingQuestionIds, type SessionExecutionStore } from "./session-execution.ts";
import { createSessionInteractionStore, type SessionInteractionStore } from "./session-interaction-store.ts";
import { createSessionMessageQueueStore, type SessionMessageQueueStore } from "./session-message-queue-store.ts";
import { createSessionOperationConnection, type SessionOperationConnection } from "./session-operation-connection.ts";
import { createSessionRenameStore, type SessionRenameStore } from "./session-rename-store.ts";
import { createSessionSettingsStore, type SessionSettingsStore } from "./session-settings-store.ts";
import { createSessionTaskControlsStore, type SessionTaskControlsStore } from "./session-task-controls.ts";

/**
 * What the page holds for one Session, whichever pane shows it: the Session's execution as the Computer reported it,
 * what the user is writing, the messages the page submitted, and what the user asked the Session to do: its requests
 * on the Computer's queue, a stop, a settings change, answers to the Agent and a confirmed rename. A pane is replaced on
 * every re-read or reconnection and only follows the Session's connection and timeline, feeding what it observes into
 * the execution state; this state lasts as long as the page, so no replacement resets a Session fact or ends a Session
 * operation.
 */
export interface SessionPageState {
    /** The Session's operations lifetime on this page; only its end cancels what the user asked the Session to do. */
    readonly lifetime: AbortSignal;
    /** How the Session's operations reach the Computer through the connection of the pane following the Session. */
    readonly connection: SessionOperationConnection;
    readonly composer: StoreApi<SessionComposerStore>;
    readonly delivery: StoreApi<SessionDeliveryStore>;
    /** The Session's execution: the one place that orders what the Computer reports about it. */
    readonly execution: StoreApi<SessionExecutionStore>;
    readonly interactions: StoreApi<SessionInteractionStore>;
    readonly queue: StoreApi<SessionMessageQueueStore>;
    readonly rename: StoreApi<SessionRenameStore>;
    readonly settings: StoreApi<SessionSettingsStore>;
    readonly tasks: StoreApi<SessionTaskControlsStore>;
}

/** Opens what the page holds for the Session, recovering what an earlier page persisted for it. */
export function createSessionPageState(options: {
    readonly computerId: string;
    readonly sessionTarget: NativeSessionTarget;
    readonly clock: Clock;
    readonly refreshTitle: (signal: AbortSignal) => Promise<void>;
    /** The page's lifetime, on which delivery and the Session's operations run. */
    readonly lifetime: AbortSignal;
}): SessionPageState {
    const { computerId, sessionTarget } = options;
    const unsentEntry = sessionUnsentMessageEntry(computerId, sessionTarget);
    const pendingEntry = sessionPendingSubmissionEntry(computerId, sessionTarget);
    // A message an earlier page left unsent returns to the composer; it is never delivered implicitly.
    const unsent = centralSessionStorage.read(unsentEntry);
    centralSessionStorage.remove(unsentEntry);
    const connection = createSessionOperationConnection();
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
    const tasks = createSessionTaskControlsStore({ clock: options.clock, sessionTarget, connection });
    const queue = createSessionMessageQueueStore({
        sessionTarget,
        connection,
        withdrawn: (commandId) => delivery.getState().withdraw(commandId),
        returned: (message) => {
            // The queued message was written first, so it goes ahead of a draft the user started since.
            tasks.getState().dismissFailure();
            queue.getState().dismissFailure();
            composer
                .getState()
                .returnMessage(
                    message.prompt,
                    message.attachments.kind === "unrestorable" && message.attachments.count > 0,
                    message.attachments.kind === "restorable" ? message.attachments.values : [],
                );
        },
    });
    /** Answers the Agent through whichever pane follows the Session, within the answer's own budget. */
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
    // Answers typed into the Agent's questions belong to the Session, as its composer draft does.
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
    });
    // What the page derives from the Computer's account follows every move of the execution state.
    const execution = createSessionExecutionStore({
        changed: (previous, next) => {
            delivery.getState().observe();
            // Drafts follow the questions the Computer's account leaves pending, not those a pane opened without.
            if (next.interactions !== previous.interactions && next.coverage.kind === "covered") {
                interactions.getState().questionsChanged(pendingQuestionIds(next.interactions));
            }
        },
    });
    return {
        lifetime: options.lifetime,
        connection,
        composer,
        delivery,
        execution,
        interactions,
        queue,
        rename: createSessionRenameStore({ sessionTarget, connection, refreshTitle: options.refreshTitle }),
        settings: createSessionSettingsStore({ computerId, sessionTarget, connection }),
        tasks,
    };
}
