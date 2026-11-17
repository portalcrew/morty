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

type ListedSession = Pick<ManagedChatSession, "target" | "status">;

/**
 * What the page remembers of a Session beyond the directory's current listing; a Session without a record shows the
 * listing. Both are facts of their moment: neither can be derived once the pane and the listing have moved on.
 */
type SessionRecord =
    /** A turn ended while the Session was not open here, and the user has not opened it since. */
    | { readonly kind: "unseen-end" }
    /**
     * A listing read before the user left or before their submission was confirmed cannot supersede the pane's account.
     */
    | { readonly kind: "left"; readonly status: ReportedStatus; readonly retainAfterLoad: boolean };

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

/**
 * What the sidebar shows for a Session. The open Session shows its pane's account once the pane has one, so a
 * submission the Computer never saw shows too. Every other Session shows what the pane left behind or else the listing.
 */
export function conversationListStatus(
    session: ListedSession,
    records: Pick<NativeSessionMap<SessionRecord>, "get">,
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
    const record = records.get(session.target);
    const status = record?.kind === "left" ? record.status : listedStatus(session.status);
    return record?.kind === "unseen-end" && status.kind !== "working" ? { kind: "unread" } : status;
}

/** Whether any listed Session holds a reply the user has not seen, as the collapsed mobile header must say. */
export function hasUnreadConversation(
    sessions: readonly ListedSession[] | null,
    records: Pick<NativeSessionMap<SessionRecord>, "get">,
    open: Parameters<typeof conversationListStatus>[2],
): boolean {
    return (sessions ?? []).some((session) => conversationListStatus(session, records, open).kind === "unread");
}

export function hasWorkingBackgroundConversation(
    sessions: readonly ListedSession[],
    records: Pick<NativeSessionMap<SessionRecord>, "get">,
    selected: NativeSessionTarget | null,
): boolean {
    return sessions.some(
        (session) =>
            (selected === null || !sameNativeSession(selected, session.target)) &&
            conversationListStatus(session, records, null).kind === "working",
    );
}

interface ConversationStatusState {
    readonly records: NativeSessionMap<SessionRecord>;
    readonly directoryLoadStarted: (submitting: readonly NativeSessionTarget[]) => void;
    /** `previous` is the listing the load replaced, or null when there was none. */
    readonly directoryLoaded: (sessions: readonly ListedSession[], previous: readonly ListedSession[] | null) => void;
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
        records: new NativeSessionMap(),
        directoryLoadStarted: (submitting) =>
            set((state) => ({
                records: new NativeSessionMap(
                    [...state.records].map(([target, record]): readonly [NativeSessionTarget, SessionRecord] => [
                        target,
                        record.kind === "left"
                            ? {
                                  ...record,
                                  retainAfterLoad: submitting.some((pending) => sameNativeSession(pending, target)),
                              }
                            : record,
                    ]),
                ),
            })),
        directoryLoaded: (sessions, previous) =>
            set((state) => {
                const records = new NativeSessionMap<SessionRecord>();
                for (const session of sessions) {
                    const record = state.records.get(session.target);
                    if (record?.kind === "left" && record.retainAfterLoad) {
                        records.set(session.target, record);
                        continue;
                    }
                    const status = listedStatus(session.status);
                    const earlier = previous?.find((candidate) => sameNativeSession(candidate.target, session.target));
                    const before =
                        record?.kind === "left"
                            ? record.status
                            : earlier === undefined
                              ? null
                              : listedStatus(earlier.status);
                    const ended = before?.kind === "working" && status.kind !== "working";
                    if (!selected(session.target) && (ended || record?.kind === "unseen-end")) {
                        records.set(session.target, { kind: "unseen-end" });
                    }
                }
                return { records };
            }),
        opened: (sessionTarget) =>
            set((state) =>
                state.records.get(sessionTarget)?.kind === "unseen-end"
                    ? { records: withoutRecord(state.records, sessionTarget) }
                    : {},
            ),
        paneReleased: (sessionTarget, activity) => {
            if (activity !== null) {
                set((state) => ({
                    records: new NativeSessionMap(state.records).set(sessionTarget, {
                        kind: "left",
                        status: paneStatus(activity),
                        retainAfterLoad: true,
                    }),
                }));
            }
        },
    }));
}

function withoutRecord(
    records: NativeSessionMap<SessionRecord>,
    sessionTarget: NativeSessionTarget,
): NativeSessionMap<SessionRecord> {
    const remaining = new NativeSessionMap(records);
    remaining.delete(sessionTarget);
    return remaining;
}
