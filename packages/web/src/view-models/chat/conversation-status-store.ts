import { NativeSessionMap, sameNativeSession } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget, SessionStatus } from "@portalcrew/morty-client/protocol";
import { createStore } from "zustand/vanilla";
import type { ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { SessionActivityState } from "./session-activity-machine.ts";

export type ConversationStatusStoreApi = ReturnType<typeof createConversationStatusStore>;

export type ConversationListStatus = ReportedStatus | { readonly kind: "unread" };

type ReportedStatus =
    | { readonly kind: "idle" }
    | { readonly commandId: string; readonly kind: "working" }
    | { readonly kind: "failed"; readonly commandId: string | null; readonly message: string };

type ListedSession = Pick<ManagedChatSession, "target" | "status">;

/**
 * What the page remembers of a Session beyond the directory's current listing; a Session without a record shows the
 * listing. Both are facts of their moment: neither can be derived once the page and the listing have moved on.
 */
type SessionRecord =
    /** A turn ended while the Session was not open here, and the user has not opened it since. */
    | { readonly kind: "unseen-end" }
    /**
     * A pane followed the Session here since the listing was read, so the page's own account of the Session describes
     * it. `newerThanLoad`: the page was still following the Session or submitting to it when the listing being read
     * began, so that listing cannot supersede the page's account either.
     */
    | { readonly kind: "followed"; readonly newerThanLoad: boolean };

function listedStatus(status: SessionStatus): ReportedStatus {
    switch (status.kind) {
        case "working":
            return status;
        case "idle":
            switch (status.lastTurn?.state) {
                case undefined:
                case "completed":
                    return { kind: "idle" };
                case "failed":
                    return { kind: "failed", commandId: status.lastTurn.commandId, message: status.lastTurn.message };
                default:
                    return status.lastTurn satisfies never;
            }
        default:
            return status satisfies never;
    }
}

/**
 * What the page knew of a Session's ended turns before a listing: the page's own account of a Session a pane followed
 * since the last listing was read, otherwise the listing the new one replaces, if it listed the Session.
 */
type EndBasis =
    | { readonly kind: "none" }
    | { readonly kind: "listing"; readonly status: SessionStatus }
    | { readonly kind: "page"; readonly observed: (commandId: string) => boolean };

/** Whether a listing reports a turn that ended unseen: the Session is idle after a turn whose end its basis did not know. */
function endedUnseen(status: SessionStatus, basis: EndBasis): boolean {
    switch (status.kind) {
        case "working":
            return false;
        case "idle": {
            const commandId = status.lastTurn?.commandId;
            if (commandId === undefined) {
                return false;
            }
            switch (basis.kind) {
                case "none":
                    return false;
                case "listing":
                    return listedEnd(basis.status) !== commandId;
                case "page":
                    return !basis.observed(commandId);
                default:
                    return basis satisfies never;
            }
        }
        default:
            return status satisfies never;
    }
}

function listedEnd(status: SessionStatus): string | null {
    switch (status.kind) {
        case "working":
            return null;
        case "idle":
            return status.lastTurn?.commandId ?? null;
        default:
            return status satisfies never;
    }
}

function pageStatus(activity: SessionActivityState): ReportedStatus {
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

function unread(session: ListedSession, record: SessionRecord | undefined): boolean {
    return record?.kind === "unseen-end" && listedStatus(session.status).kind !== "working";
}

/**
 * What the sidebar shows for a Session. A Session a pane followed since the listing was read shows the page's account
 * of it once the page has one, so a submission the Computer never saw shows too, and so does its outcome after the
 * user moved on. Every other Session shows the listing.
 */
export function conversationListStatus(
    session: ListedSession,
    record: SessionRecord | undefined,
    activity: SessionActivityState | null,
): ConversationListStatus {
    if (record?.kind === "followed" && activity !== null) {
        return pageStatus(activity);
    }
    return unread(session, record) ? { kind: "unread" } : listedStatus(session.status);
}

/**
 * Whether any listed Session holds a reply the user has not seen, as the collapsed mobile header must say. An unseen
 * end is never recorded beside an observation, so the page's accounts cannot change the answer.
 */
export function hasUnreadConversation(
    sessions: readonly ListedSession[] | null,
    records: Pick<NativeSessionMap<SessionRecord>, "get">,
): boolean {
    return (sessions ?? []).some((session) => unread(session, records.get(session.target)));
}

export function hasWorkingBackgroundConversation(
    sessions: readonly ListedSession[],
    records: Pick<NativeSessionMap<SessionRecord>, "get">,
    activity: (sessionTarget: NativeSessionTarget) => SessionActivityState | null,
    selected: NativeSessionTarget | null,
): boolean {
    return sessions.some(
        (session) =>
            (selected === null || !sameNativeSession(selected, session.target)) &&
            conversationListStatus(session, records.get(session.target), activity(session.target)).kind === "working",
    );
}

interface ConversationStatusState {
    readonly records: NativeSessionMap<SessionRecord>;
    /** `following` are the Sessions whose account the page still updates: the one a pane follows and those submitting. */
    readonly directoryLoadStarted: (following: readonly NativeSessionTarget[]) => void;
    /** `previous` is the listing the load replaced, or null when there was none. */
    readonly directoryLoaded: (sessions: readonly ListedSession[], previous: readonly ListedSession[] | null) => void;
    /** The user opened this Session, so nothing it finished is unseen. */
    readonly opened: (sessionTarget: NativeSessionTarget) => void;
    /** A pane started following this Session, so the page's account of it is newer than any listing being read. */
    readonly followed: (sessionTarget: NativeSessionTarget) => void;
}

export function createConversationStatusStore(ports: {
    readonly selectedSessionId: () => NativeSessionTarget | null;
    /** The page's account of the Session, or null while it has none. */
    readonly activity: (sessionTarget: NativeSessionTarget) => SessionActivityState | null;
    /** Whether the page's account of the Session learned that the command ended. */
    readonly endObserved: (sessionTarget: NativeSessionTarget, commandId: string) => boolean;
}) {
    const selected = (target: NativeSessionTarget): boolean => {
        const current = ports.selectedSessionId();
        return current !== null && sameNativeSession(current, target);
    };

    return createStore<ConversationStatusState>((set) => ({
        records: new NativeSessionMap(),
        directoryLoadStarted: (following) =>
            set((state) => ({
                records: new NativeSessionMap(
                    [...state.records].map(([target, record]): readonly [NativeSessionTarget, SessionRecord] => [
                        target,
                        record.kind === "followed"
                            ? {
                                  kind: "followed",
                                  newerThanLoad: following.some((current) => sameNativeSession(current, target)),
                              }
                            : record,
                    ]),
                ),
            })),
        directoryLoaded: (sessions, previous) =>
            set((state) => {
                const records = new NativeSessionMap<SessionRecord>();
                // A Session the page still follows may not be listed yet, as a Session created here.
                for (const [target, record] of state.records) {
                    if (record.kind === "followed" && record.newerThanLoad) {
                        records.set(target, record);
                    }
                }
                for (const session of sessions) {
                    const record = state.records.get(session.target);
                    if (records.has(session.target)) {
                        continue;
                    }
                    const earlier = previous?.find((candidate) => sameNativeSession(candidate.target, session.target));
                    const basis: EndBasis =
                        record?.kind === "followed" && ports.activity(session.target) !== null
                            ? { kind: "page", observed: (commandId) => ports.endObserved(session.target, commandId) }
                            : earlier === undefined
                              ? { kind: "none" }
                              : { kind: "listing", status: earlier.status };
                    const ended = endedUnseen(session.status, basis);
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
        followed: (sessionTarget) =>
            set((state) => ({
                records: new NativeSessionMap(state.records).set(sessionTarget, {
                    kind: "followed",
                    newerThanLoad: true,
                }),
            })),
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
