import type {
    AcpSessionUpdate,
    NativeSessionTarget,
    SessionEventPayload,
    SessionLiveEvent,
} from "@morty-build/client/protocol";
import type { SettledTurn } from "../turn/execution-receipts.ts";
import type { SessionEventPage, SessionEventStore } from "./session-event-store.ts";

interface PlacedLifecycle {
    readonly event: SessionEventPayload;
    readonly recordedAt: string;
}

function lifecycle(payload: Extract<SessionEventPayload, { readonly type: "lifecycle-metadata" }>["payload"]) {
    return { payload, type: "lifecycle-metadata" } satisfies SessionEventPayload;
}

/** A settled turn's start, as the Runtime recorded it when the turn joined the Session. */
function turnStart(turn: SettledTurn, content: AcpSessionUpdate, steers: string | null): PlacedLifecycle[] {
    const { commandId } = turn.outcome;
    const requested =
        content.sessionUpdate === "user_message_chunk"
            ? lifecycle({
                  commandId,
                  content: [content.content],
                  kind: "prompt.requested",
                  dispatch: steers === null ? { kind: "own" } : { kind: "steer", targetCommandId: steers },
              })
            : null;
    const started = lifecycle({ attemptId: turn.attemptId, commandId, kind: "prompt.started" });
    return [
        ...(requested === null ? [] : [{ event: requested, recordedAt: turn.startedAt }]),
        { event: started, recordedAt: turn.startedAt },
    ];
}

const turnEnd = (turn: SettledTurn): PlacedLifecycle => ({
    event: lifecycle(turn.outcome),
    recordedAt: turn.recordedAt,
});

/**
 * Places the lifecycle of the turns the Runtime ran among the Agent's replayed history, where they happened. A turn
 * starts at the user message its Agent recorded for it and ends before the next user message that does not steer into
 * it, or where the replay ends. A message steered into a turn joins that turn.
 */
class ReplayedTurns {
    readonly #byMessage: ReadonlyMap<string, SettledTurn>;
    #open: SettledTurn | null = null;
    /** The user message the latest replayed event belongs to; undefined after any other event. */
    #userMessage: { readonly messageId: string } | undefined;

    constructor(turns: readonly SettledTurn[]) {
        this.#byMessage = new Map(turns.map((turn) => [turn.outcome.messageId, turn]));
    }

    /** The lifecycle that precedes `update` in history. */
    readonly before = (update: AcpSessionUpdate): readonly PlacedLifecycle[] => {
        if (update.sessionUpdate !== "user_message_chunk") {
            this.#userMessage = undefined;
            return [];
        }
        const messageId = update.messageId;
        if (this.#userMessage?.messageId === messageId) {
            return [];
        }
        this.#userMessage = { messageId };
        const turn = this.#byMessage.get(messageId);
        const steered = turn?.outcome.kind === "prompt.completed" && turn.outcome.completion.kind === "steered";
        const open = this.#open;
        if (turn !== undefined && steered && open !== null) {
            return [...turnStart(turn, update, open.outcome.commandId), turnEnd(turn)];
        }
        const ended = this.end();
        if (turn === undefined || steered) {
            return ended;
        }
        this.#open = turn;
        return [...ended, ...turnStart(turn, update, null)];
    };

    /** The ending of the turn still open where the replay ends. */
    readonly end = (): readonly PlacedLifecycle[] => {
        const open = this.#open;
        this.#open = null;
        return open === null ? [] : [turnEnd(open)];
    };
}

/** Captures ACP updates into the V2 session event log. */
export class HistoryReplayCapture {
    readonly #events: SessionEventStore;
    readonly #sessionTarget: NativeSessionTarget;
    readonly #replayed: ReplayedTurns;

    constructor(
        events: SessionEventStore,
        sessionTarget: NativeSessionTarget,
        settledTurns: readonly SettledTurn[] = [],
    ) {
        this.#events = events;
        this.#sessionTarget = sessionTarget;
        this.#replayed = new ReplayedTurns(settledTurns);
    }

    /** Records an update the Agent replays from its own history, with the lifecycle of the turn it belongs to. */
    readonly replay = (rawUpdate: AcpSessionUpdate): void => {
        for (const { event, recordedAt } of this.#replayed.before(rawUpdate)) {
            this.#events.append(this.#sessionTarget, event, recordedAt);
        }
        this.#events.append(this.#sessionTarget, { payload: rawUpdate, type: "acp" });
    };

    /** Ends the replay: the last replayed turn ends where the Agent's history does. */
    readonly finishReplay = (): void => {
        for (const { event, recordedAt } of this.#replayed.end()) {
            this.#events.append(this.#sessionTarget, event, recordedAt);
        }
    };

    readonly record = (rawUpdate: AcpSessionUpdate): SessionLiveEvent =>
        this.#events.append(this.#sessionTarget, { payload: rawUpdate, type: "acp" });

    readonly recordLifecycle = (event: SessionEventPayload): SessionLiveEvent => {
        if (event.type !== "lifecycle-metadata") {
            throw new Error("Lifecycle history only accepts lifecycle metadata");
        }
        return this.#events.append(this.#sessionTarget, event);
    };

    readonly eventPage = (eventLimit: number, cursor: string | null): SessionEventPage =>
        this.#events.page(this.#sessionTarget, eventLimit, cursor);
}
