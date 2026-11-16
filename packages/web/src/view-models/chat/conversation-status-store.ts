import { NativeSessionMap, sameNativeSession } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";
import type { SessionConnection } from "./session-connection.ts";
import type { DeliveryState } from "./session-delivery-store.ts";
import { paneActivity, type SessionExecutionState } from "./session-execution.ts";

export type ConversationStatusStoreApi = ReturnType<typeof createConversationStatusStore>;

export type ConversationListStatus = ReportedStatus | { readonly kind: "unread" };

type ReportedStatus =
    | { readonly kind: "idle" }
    | { readonly commandId: string; readonly kind: "working" }
    | { readonly kind: "failed"; readonly commandId: string | null; readonly message: string };

interface SessionObservation {
    readonly status: ReportedStatus;
    /** A turn ended while the Session was not open here, and the user has not opened it since. */
    readonly unseenEnd: boolean;
    readonly observedAt: number;
}

function listedStatus(status: ManagedChatSession["status"]): ReportedStatus {
    if (status.kind === "working") {
        return status;
    }
    return status.failedTurn === undefined
        ? { kind: "idle" }
        : { kind: "failed", commandId: status.failedTurn.commandId, message: status.failedTurn.message };
}

function paneStatus(activity: SessionActivityState): ReportedStatus {
    switch (activity.kind) {
        case "idle":
        case "working":
            return activity;
        case "failed":
            return { kind: "failed", commandId: activity.commandId, message: activity.message };
        default:
            return activity satisfies never;
    }
}

function observe(
    previous: SessionObservation | undefined,
    status: ReportedStatus,
    watched: boolean,
    observedAt: number,
): SessionObservation {
    const ended = previous?.status.kind === "working" && status.kind !== "working";
    return { status, unseenEnd: !watched && (ended || previous?.unseenEnd === true), observedAt };
}

function shown(observation: SessionObservation): ConversationListStatus {
    return observation.unseenEnd && observation.status.kind !== "working" ? { kind: "unread" } : observation.status;
}

/**
 * What the sidebar shows for a Session. The open Session shows its pane's account once the pane has one, so a
 * submission the Computer never saw shows too. Every other Session shows what the page last learned of it.
 */
export function conversationListStatus(
    session: Pick<ManagedChatSession, "target" | "status">,
    observations: Pick<NativeSessionMap<SessionObservation>, "get">,
    open: {
        readonly sessionTarget: NativeSessionTarget;
        readonly connection: SessionConnection;
        readonly execution: Pick<SessionExecutionState, "turn" | "commands">;
        readonly delivery: DeliveryState;
    } | null,
): ConversationListStatus {
    const activity =
        open !== null && sameNativeSession(open.sessionTarget, session.target)
            ? paneActivity(open.connection, open.execution, open.delivery)
            : null;
    if (activity !== null) {
        return paneStatus(activity);
    }
    const observation = observations.get(session.target);
    return observation === undefined ? listedStatus(session.status) : shown(observation);
}

/** Whether any listed Session holds a reply the user has not seen, as the collapsed mobile header must say. */
export function hasUnreadConversation(
    sessions: readonly Pick<ManagedChatSession, "target" | "status">[] | null,
    observations: Pick<NativeSessionMap<SessionObservation>, "get">,
    open: Parameters<typeof conversationListStatus>[2],
): boolean {
    return (sessions ?? []).some((session) => conversationListStatus(session, observations, open).kind === "unread");
}

interface ConversationStatusState {
    readonly observations: NativeSessionMap<SessionObservation>;
    readonly learned: number;
    readonly directoryBasis: number;
    readonly directoryLoadStarted: () => void;
    readonly directoryLoaded: (sessions: readonly ManagedChatSession[]) => void;
    /** The user opened this Session, so nothing it finished is unseen. */
    readonly opened: (sessionTarget: NativeSessionTarget) => void;
    readonly paneReleased: (sessionTarget: NativeSessionTarget, activity: SessionActivityState | null) => void;
}

export function createConversationStatusStore(selectedSessionId: () => NativeSessionTarget | null) {
    const selected = (target: NativeSessionTarget): boolean => {
        const current = selectedSessionId();
        return current !== null && sameNativeSession(current, target);
    };

    return createStore<ConversationStatusState>((set) => ({
        observations: new NativeSessionMap(),
        learned: 0,
        directoryBasis: 0,
        directoryLoadStarted: () => set((state) => ({ directoryBasis: state.learned })),
        directoryLoaded: (sessions) =>
            set((state) => {
                const observedAt = state.learned + 1;
                const entries = sessions.map((session): readonly [NativeSessionTarget, SessionObservation] => {
                    const previous = state.observations.get(session.target);
                    // An account learned after the load began is newer than its snapshot.
                    if (previous !== undefined && previous.observedAt > state.directoryBasis) {
                        return [session.target, previous];
                    }
                    const status = listedStatus(session.status);
                    return [session.target, observe(previous, status, selected(session.target), observedAt)];
                });
                return { observations: new NativeSessionMap(entries), learned: observedAt };
            }),
        opened: (sessionTarget) =>
            set((state) => {
                const previous = state.observations.get(sessionTarget);
                return previous?.unseenEnd === true
                    ? {
                          observations: new NativeSessionMap(state.observations).set(sessionTarget, {
                              ...previous,
                              unseenEnd: false,
                          }),
                      }
                    : {};
            }),
        paneReleased: (sessionTarget, activity) => {
            if (activity === null) {
                return;
            }
            set((state) => {
                const observedAt = state.learned + 1;
                // The pane showed the Session, so what it saw end was seen.
                const observation = observe(
                    state.observations.get(sessionTarget),
                    paneStatus(activity),
                    true,
                    observedAt,
                );
                return {
                    observations: new NativeSessionMap(state.observations).set(sessionTarget, observation),
                    learned: observedAt,
                };
            });
        },
    }));
}
