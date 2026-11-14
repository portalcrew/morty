import type { SessionEvent, SessionLiveEvent } from "@morty-build/client/protocol";
import type { SessionPresentationEvent } from "./session-presentation.ts";
import {
    appendSessionMessageEvent,
    createSessionMessageReduction,
    mergeEventsById,
    prependSessionMessageEvents,
    type SessionExecutionMessage,
    type SessionExecutionObservation,
    type SessionMessageReduction,
    sessionReductionExecutionOwner,
    sessionReductionMessages,
} from "./session-presentation.ts";

export interface SessionEventHistory {
    readonly throughPosition: string;
    readonly events: readonly SessionEvent[];
    readonly nextCursor: string | null;
    readonly sessionGenerationId: string;
}

interface PendingEvents {
    readonly generation: string | null;
    readonly buffer: readonly SessionLiveEvent[];
}

/**
 * Loading the page of history before the oldest message shown. It belongs to the baseline it extends: a new baseline
 * starts idle, so no load of a replaced history can leave it loading. A failure lasts until the next load.
 */
export type OlderHistory =
    | { readonly kind: "idle" }
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string };

export type SessionProjection =
    | { readonly kind: "pristine"; readonly pending: PendingEvents | null; readonly revision: number }
    | {
          readonly kind: "established";
          readonly eventIds: ReadonlySet<string>;
          readonly generation: string;
          readonly firstEventId: string | null;
          readonly throughPosition: string;
          readonly pagination: { readonly nextCursor: string | null; readonly older: OlderHistory };
          readonly pending: PendingEvents | null;
          readonly reduction: SessionMessageReduction;
          readonly revision: number;
      };

export type SessionProjectionInput =
    | { readonly event: SessionLiveEvent; readonly kind: "live-event" }
    | { readonly kind: "reconcile" }
    | { readonly history: SessionEventHistory; readonly kind: "history-loaded"; readonly revision: number }
    /** A load of the page before `revision`'s oldest message began. */
    | { readonly kind: "older-page-requested"; readonly revision: number }
    | { readonly kind: "older-page"; readonly page: SessionEventHistory; readonly revision: number }
    /** The load of the page before `revision`'s oldest message failed, or ended without a page. */
    | { readonly kind: "older-page-failed"; readonly revision: number; readonly message: string | null };

export type SessionProjectionEffect =
    | { readonly generation: string | null; readonly kind: "load-history" }
    | {
          readonly kind: "adopted";
          readonly title?: string | undefined;
      }
    /**
     * The history was loaded again: the page may have missed settings changes, and the history's settings events
     * cannot tell the current settings, because a change made from a settings menu writes none. The Computer is asked
     * for its current settings.
     */
    | { readonly kind: "read-settings" };

export interface SessionProjectionResult {
    readonly effects: readonly SessionProjectionEffect[];
    readonly state: SessionProjection;
}

export function createSessionProjection(): SessionProjection {
    return { kind: "pristine", pending: null, revision: 0 };
}

function newestTitle(events: readonly SessionPresentationEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (
            event?.type === "acp" &&
            event.payload.sessionUpdate === "session_info_update" &&
            Object.hasOwn(event.payload, "title") &&
            event.payload.title !== null &&
            event.payload.title !== undefined
        ) {
            return event.payload.title;
        }
    }
    return undefined;
}

/** Live settings updates invalidate the display; only a Computer read establishes current settings. */
function adoptionEffect(events: readonly SessionPresentationEvent[]): readonly SessionProjectionEffect[] {
    const title = newestTitle(events);
    const configurationChanged = events.some(
        (event) =>
            event.type === "acp" &&
            (event.payload.sessionUpdate === "config_option_update" ||
                event.payload.sessionUpdate === "current_mode_update"),
    );
    return [
        ...(title === undefined ? [] : [{ kind: "adopted" as const, title }]),
        ...(configurationChanged ? [{ kind: "read-settings" as const }] : []),
    ];
}

/** A new history baseline adopts its title, and leaves the current settings to the Computer. */
function baselineEffects(events: readonly SessionPresentationEvent[]): readonly SessionProjectionEffect[] {
    const title = newestTitle(events);
    return [...(title === undefined ? [] : [{ kind: "adopted" as const, title }]), { kind: "read-settings" }];
}

function adoptGeneration(
    state: SessionProjection,
    history: SessionEventHistory,
    events: readonly SessionPresentationEvent[],
): SessionProjection {
    return {
        eventIds: new Set(events.map((event) => event.eventId)),
        generation: history.sessionGenerationId,
        firstEventId: events.at(0)?.eventId ?? null,
        throughPosition: history.throughPosition,
        kind: "established",
        pagination: { nextCursor: history.nextCursor, older: { kind: "idle" } },
        pending: null,
        reduction: createSessionMessageReduction({ events, nextCursor: history.nextCursor }),
        revision: state.revision + 1,
    };
}

export function transitionSessionProjection(
    state: SessionProjection,
    input: SessionProjectionInput,
): SessionProjectionResult {
    switch (input.kind) {
        case "live-event": {
            const { event } = input;
            if (state.kind === "pristine" || event.sessionGenerationId !== state.generation) {
                if (state.pending?.generation === event.sessionGenerationId) {
                    return {
                        effects: [],
                        state: { ...state, pending: { ...state.pending, buffer: [...state.pending.buffer, event] } },
                    };
                }
                const revision = state.revision + 1;
                return {
                    effects: [{ generation: event.sessionGenerationId, kind: "load-history" }],
                    state: {
                        ...state,
                        pending: { buffer: [event], generation: event.sessionGenerationId },
                        revision,
                    },
                };
            }
            if (state.pending !== null) {
                return {
                    effects: [],
                    state:
                        state.pending.generation !== null
                            ? state
                            : {
                                  ...state,
                                  pending: { ...state.pending, buffer: [...state.pending.buffer, event] },
                              },
                };
            }
            if (BigInt(event.position) <= BigInt(state.throughPosition) || state.eventIds.has(event.eventId)) {
                return { effects: [], state };
            }
            return {
                effects: adoptionEffect([event]),
                state: {
                    ...state,
                    eventIds: new Set([...state.eventIds, event.eventId]),
                    firstEventId: state.firstEventId ?? event.eventId,
                    reduction: appendSessionMessageEvent(state.reduction, event),
                },
            };
        }
        case "reconcile": {
            const revision = state.revision + 1;
            return {
                effects: [{ generation: null, kind: "load-history" }],
                state: { ...state, pending: { buffer: [], generation: null }, revision },
            };
        }
        case "history-loaded": {
            if (state.pending === null || input.revision !== state.revision) {
                return { effects: [], state };
            }
            const events = mergeEventsById(
                input.history.events,
                state.pending.buffer.filter(
                    (event) =>
                        event.sessionGenerationId === input.history.sessionGenerationId &&
                        BigInt(event.position) > BigInt(input.history.throughPosition),
                ),
            );
            return {
                effects: baselineEffects(events),
                state: adoptGeneration(state, input.history, events),
            };
        }
        case "older-page-requested": {
            if (
                state.kind !== "established" ||
                input.revision !== state.revision ||
                state.pagination.older.kind === "loading"
            ) {
                return { effects: [], state };
            }
            return {
                effects: [],
                state: { ...state, pagination: { ...state.pagination, older: { kind: "loading" } } },
            };
        }
        case "older-page-failed": {
            if (state.kind !== "established" || input.revision !== state.revision) {
                return { effects: [], state };
            }
            return {
                effects: [],
                state: {
                    ...state,
                    pagination: {
                        ...state.pagination,
                        older: input.message === null ? { kind: "idle" } : { kind: "failed", message: input.message },
                    },
                },
            };
        }
        case "older-page": {
            if (
                state.kind !== "established" ||
                state.pending !== null ||
                input.revision !== state.revision ||
                input.page.sessionGenerationId !== state.generation
            ) {
                return { effects: [], state };
            }
            return {
                effects: [],
                state: {
                    ...state,
                    pagination: { nextCursor: input.page.nextCursor, older: { kind: "idle" } },
                    firstEventId: input.page.events.at(0)?.eventId ?? state.firstEventId,
                    eventIds: new Set([...input.page.events.map((event) => event.eventId), ...state.eventIds]),
                    reduction: prependSessionMessageEvents(state.reduction, input.page),
                    revision: state.revision + 1,
                },
            };
        }
        default:
            return input satisfies never;
    }
}

export function sessionProjectionExecutionOwner(state: SessionProjection, commandId: string): string | null {
    return state.kind === "established" ? sessionReductionExecutionOwner(state.reduction, commandId) : null;
}

function sessionProjectionMessages(
    state: SessionProjection,
    observations: readonly SessionExecutionObservation[],
): readonly SessionExecutionMessage[] {
    return state.kind === "established"
        ? sessionReductionMessages(
              state.reduction,
              // A report describes the log generation it covers. One from before the history baseline says nothing the
              // baseline does not hold, and no event of the baseline has a position to place it by.
              observations.filter(
                  (observation) =>
                      observation.kind === "closed" ||
                      (observation.generation === state.generation &&
                          BigInt(observation.position) >= BigInt(state.throughPosition)),
              ),
          )
        : [];
}

/** The page before the oldest message shown, when one exists and can be loaded now. */
export function sessionProjectionPagination(
    state: SessionProjection,
): { readonly generation: string; readonly nextCursor: string; readonly revision: number } | null {
    return state.kind === "established" &&
        state.pending === null &&
        state.pagination.nextCursor !== null &&
        state.pagination.older.kind !== "loading"
        ? { generation: state.generation, nextCursor: state.pagination.nextCursor, revision: state.revision }
        : null;
}

/** The loading of older history for the baseline shown; a projection without one loads none. */
export function sessionProjectionOlderHistory(state: SessionProjection): OlderHistory {
    return state.kind === "established" ? state.pagination.older : { kind: "idle" };
}

/**
 * The timeline a projection shows: its messages, whether older history exists, and its revision. The messages are the
 * events' own, read against what the Computer reported of the execution. A projection and the reports are immutable, so
 * the timeline computed for one pair is reused for every reader of it.
 */
export interface SessionTimeline {
    readonly messages: readonly SessionExecutionMessage[];
    readonly hasOlderHistory: boolean;
    readonly revision: number;
}
const timelines = new WeakMap<
    SessionProjection,
    { readonly observations: readonly SessionExecutionObservation[]; readonly timeline: SessionTimeline }
>();
export function sessionProjectionTimeline(
    state: SessionProjection,
    observations: readonly SessionExecutionObservation[],
): SessionTimeline {
    const known = timelines.get(state);
    if (known !== undefined && known.observations === observations) {
        return known.timeline;
    }
    const timeline: SessionTimeline = {
        messages: sessionProjectionMessages(state, observations),
        hasOlderHistory: state.kind === "established" && state.pending === null && state.pagination.nextCursor !== null,
        revision: state.revision,
    };
    timelines.set(state, { observations, timeline });
    return timeline;
}
