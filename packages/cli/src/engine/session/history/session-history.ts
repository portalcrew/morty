import type {
    AcpSessionUpdate,
    NativeSessionTarget,
    SessionEventPayload,
    SessionLiveEvent,
} from "@portalcrew/morty-client/protocol";
import type { SettledTurn } from "../turn/execution-receipts.ts";
import type { SessionEventPage, SessionEventStore } from "./session-event-store.ts";

interface PlacedLifecycle {
    readonly event: SessionEventPayload;
    readonly recordedAt: string;
}

function lifecycle(payload: Extract<SessionEventPayload, { readonly type: "lifecycle-metadata" }>["payload"]) {
    return { payload, type: "lifecycle-metadata" } satisfies SessionEventPayload;
}

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

class ReplayedTurns {
    readonly #byMessage: ReadonlyMap<string, SettledTurn>;
    #open: SettledTurn | null = null;
    #userMessage: { readonly messageId: string } | undefined;

    constructor(turns: readonly SettledTurn[]) {
        this.#byMessage = new Map(turns.map((turn) => [turn.outcome.messageId, turn]));
    }

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

    readonly end = (): readonly PlacedLifecycle[] => {
        const open = this.#open;
        this.#open = null;
        return open === null ? [] : [turnEnd(open)];
    };
}

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

    readonly replay = (rawUpdate: AcpSessionUpdate): void => {
        for (const { event, recordedAt } of this.#replayed.before(rawUpdate)) {
            this.#events.append(this.#sessionTarget, event, recordedAt);
        }
        this.#events.append(this.#sessionTarget, { payload: rawUpdate, type: "acp" });
    };

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
