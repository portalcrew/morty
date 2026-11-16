import { type MortyClient, MortyPageRequest, MortyTimeoutError } from "@portalcrew/morty-client";
import type { NativeSessionTarget, SessionEvent } from "@portalcrew/morty-client/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Clock } from "../../services/time/clock.ts";
import { formatError } from "../format-error.ts";
import type { SessionExecutionStore } from "./session-execution.ts";
import type { SessionOperationFeedbackStore } from "./session-operation-feedback.ts";
import {
    createSessionMessageReduction,
    mergeEventsById,
    sessionEventCommandIds,
    sessionReductionMessages,
    sessionUserCommandIds,
} from "./session-presentation.ts";
import {
    createSessionProjection,
    type SessionEventHistory,
    type SessionProjection,
    type SessionProjectionEffect,
    type SessionProjectionInput,
    sessionProjectionExecutionOwner,
    sessionProjectionPagination,
    sessionProjectionTimeline,
    transitionSessionProjection,
} from "./session-projection.ts";
import type { SessionSettingsStore } from "./session-settings-store.ts";
import type { SessionTitlesStore } from "./session-titles-store.ts";

const SESSION_EVENT_PAGE_LIMIT = 30;
const HISTORY_MESSAGE_TARGET = 20;
const HISTORY_READ_DEADLINE_MS = 45_000;

interface SessionHistoryStore {
    /** The Session's history as this pane's connection follows it, the only source of the timeline. */
    readonly projection: SessionProjection;
    readonly loadOlderMessages: (signal: AbortSignal) => Promise<void>;
}

export interface SessionHistory {
    readonly store: StoreApi<SessionHistoryStore>;
    /** Applies a live event or a reconcile to the projection and reads the history the transition asks for. */
    readonly dispatch: (input: SessionProjectionInput, connected: MortyClient, signal: AbortSignal) => Promise<void>;
    /** The command whose execution a command's message belongs to, or null when the history does not tell. */
    readonly executionOwner: (commandId: string) => string | null;
}

async function readSessionHistory(
    client: MortyClient,
    sessionTarget: NativeSessionTarget,
    initialCursor: string | null,
    newerEvents: readonly SessionEvent[],
    expectedSessionGenerationId: string | null,
    signal: AbortSignal,
    loadedRange: { readonly generation: string; readonly firstEventId: string | null } | null = null,
): Promise<SessionEventHistory> {
    let events: readonly SessionEvent[] = newerEvents;
    let nextCursor = initialCursor;
    // Loading the newest page can itself restore native history and replace the
    // generation announced by a preceding live event. That page owns the baseline;
    // only older pages must match the generation we have already adopted.
    let sessionGenerationId = initialCursor === null ? null : expectedSessionGenerationId;
    let throughPosition: string | null = null;
    let renderableMessages = sessionReductionMessages(createSessionMessageReduction({ events, nextCursor }));
    do {
        const requestedCursor = nextCursor;
        const page = await client.events.list(
            sessionTarget,
            new MortyPageRequest(SESSION_EVENT_PAGE_LIMIT, requestedCursor ?? ""),
            signal,
        );
        signal.throwIfAborted();
        // Only the newest page defines which live deltas the snapshot covers.
        if (requestedCursor === initialCursor) {
            throughPosition = page.throughPosition;
        }
        if (sessionGenerationId !== null && page.sessionGenerationId !== sessionGenerationId) {
            throw new Error("The Session reloaded while message history was loading.");
        }
        if (requestedCursor !== null && page.nextCursor === requestedCursor) {
            throw new Error("The Computer returned the same message-history cursor twice.");
        }
        sessionGenerationId = page.sessionGenerationId;
        events = mergeEventsById(page.events, events);
        nextCursor = page.nextCursor;
        renderableMessages = sessionReductionMessages(createSessionMessageReduction({ events, nextCursor }));
    } while (
        nextCursor !== null &&
        (renderableMessages.length < HISTORY_MESSAGE_TARGET ||
            (loadedRange !== null &&
                loadedRange.generation === sessionGenerationId &&
                loadedRange.firstEventId !== null &&
                !events.some((event) => event.eventId === loadedRange.firstEventId)))
    );
    if (sessionGenerationId === null || throughPosition === null) {
        throw new Error("The Computer returned no Session history generation.");
    }
    return { events, nextCursor, sessionGenerationId, throughPosition };
}

async function untilSettledOrAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

export function createSessionHistory(options: {
    readonly clock: Clock;
    readonly sessionTarget: NativeSessionTarget;
    /** The pane's lifetime. */
    readonly lifetime: AbortSignal;
    readonly execution: StoreApi<SessionExecutionStore>;
    readonly settings: StoreApi<SessionSettingsStore>;
    readonly feedback: StoreApi<SessionOperationFeedbackStore>;
    readonly titles: SessionTitlesStore;
    readonly connectedClient: () => MortyClient | null;
    /** Reports a failure of an operation sent through `connected`; true when it closed the Session. */
    readonly failedThrough: (connected: MortyClient, cause: unknown) => boolean;
}): SessionHistory {
    const { clock, sessionTarget, execution, settings, feedback, titles } = options;
    let historyLoadController: AbortController | null = null;
    let olderHistoryLoad: Promise<void> | null = null;
    const store = createStore<SessionHistoryStore>()(() => ({
        projection: createSessionProjection(),
        loadOlderMessages: async (signal) => {
            if (olderHistoryLoad === null) {
                const loading = loadOlderHistory().finally(() => {
                    if (olderHistoryLoad === loading) {
                        olderHistoryLoad = null;
                    }
                });
                olderHistoryLoad = loading;
            }
            await untilSettledOrAborted(olderHistoryLoad, signal);
        },
    }));
    const projection = (): SessionProjection => store.getState().projection;
    // The command ids the history names are facts the Computer's account holds, so the execution state learns them.
    const setProjection = (next: SessionProjection, recorded: readonly string[] = []): void => {
        store.setState({ projection: next });
        execution.getState().apply({
            kind: "history",
            shown: sessionUserCommandIds(
                sessionProjectionTimeline(next, execution.getState().state.observations).messages,
            ),
            recorded,
        });
    };
    const commit = (
        input: SessionProjectionInput,
        recorded: readonly string[] = [],
    ): readonly SessionProjectionEffect[] => {
        const result = transitionSessionProjection(projection(), input);
        if (result.state !== projection()) {
            setProjection(result.state, recorded);
        }
        for (const effect of result.effects) {
            if (effect.kind === "adopted" && effect.title !== undefined) {
                titles.getState().observed(sessionTarget, effect.title);
            }
        }
        return result.effects;
    };
    const readSettings = (connected: MortyClient, signal: AbortSignal): void => {
        settings
            .getState()
            .readInBackground((readSignal) => connected.sessions.readConfiguration(sessionTarget, readSignal), signal);
    };
    const loadNewestHistory = async (
        effect: Extract<SessionProjectionEffect, { readonly kind: "load-history" }>,
        connected: MortyClient,
        parentSignal: AbortSignal,
    ): Promise<void> => {
        historyLoadController?.abort();
        const controller = new AbortController();
        historyLoadController = controller;
        const revision = projection().revision;
        const deadline = new AbortController();
        const signal = AbortSignal.any([parentSignal, controller.signal, deadline.signal]);
        void clock.sleep(HISTORY_READ_DEADLINE_MS, signal).then(
            () => deadline.abort(new DOMException("The Session history read timed out.", "TimeoutError")),
            () => undefined,
        );
        try {
            const loaded = projection();
            const history = await readSessionHistory(
                connected,
                sessionTarget,
                null,
                [],
                effect.generation,
                signal,
                loaded.kind === "established" ? loaded : null,
            );
            parentSignal.throwIfAborted();
            const current = projection();
            if (controller.signal.aborted || current.pending === null || current.revision !== revision) {
                return;
            }
            const effects = commit(
                { history, kind: "history-loaded", revision },
                sessionEventCommandIds(history.events),
            );
            if (effects.some((loaded) => loaded.kind === "read-settings")) {
                readSettings(connected, parentSignal);
            }
        } catch (cause) {
            parentSignal.throwIfAborted();
            if (controller.signal.aborted || projection().revision !== revision) {
                return;
            }
            // This pane owns the history deadline. The session client only sees an aborted
            // caller signal, so retain timeout semantics for subscription recovery.
            if (deadline.signal.aborted) {
                throw new MortyTimeoutError({ cause });
            }
            throw cause;
        } finally {
            deadline.abort();
            if (historyLoadController === controller) {
                historyLoadController = null;
            }
        }
    };
    const loadOlderHistory = async (): Promise<void> => {
        const pagination = sessionProjectionPagination(projection());
        const connected = options.connectedClient();
        if (pagination === null || connected === null) {
            return;
        }
        const { revision } = pagination;
        feedback.getState().retried("older-history");
        commit({ kind: "older-page-requested", revision });
        try {
            const page = await readSessionHistory(
                connected,
                sessionTarget,
                pagination.nextCursor,
                [],
                pagination.generation,
                options.lifetime,
            );
            commit({ kind: "older-page", page, revision });
        } catch (cause) {
            if (options.lifetime.aborted) {
                return;
            }
            commit({ kind: "older-page-failed", revision });
            if (options.failedThrough(connected, cause)) {
                return;
            }
            feedback.getState().failed({
                operation: "older-history",
                message: formatError(cause, "Older messages could not be loaded."),
            });
            throw cause;
        }
    };
    return {
        store,
        dispatch: async (input, connected, signal) => {
            for (const effect of commit(input)) {
                if (effect.kind === "load-history") {
                    await loadNewestHistory(effect, connected, signal);
                } else if (effect.kind === "read-settings") {
                    readSettings(connected, signal);
                }
            }
        },
        executionOwner: (commandId) => sessionProjectionExecutionOwner(projection(), commandId),
    };
}
