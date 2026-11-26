import { NativeSessionMap } from "@portalcrew/morty-client/native-session";
import type {
    CommandStanding,
    NativeSessionTarget,
    SessionExecution,
    SessionPromptCommand,
    SessionStatus,
} from "@portalcrew/morty-client/protocol";
import type { ActiveRuntimeTurn, PromptDispatch } from "./active-turn.ts";
import type { ExecutionReceipts } from "./execution-receipts.ts";
import { SessionExecutionState, type SessionExecutions } from "./session-execution.ts";

type TurnRead = SessionExecution extends infer Read
    ? Read extends unknown
        ? Omit<Read, "executionPosition" | "interactions" | "delivery">
        : never
    : never;

export class SessionTurns {
    readonly #bySessionTarget = new NativeSessionMap<SessionExecutionState>();
    readonly #operations: ExecutionReceipts;
    readonly #executions: SessionExecutions;
    readonly #onFinished: (sessionTarget: NativeSessionTarget) => void;
    readonly #onWorking: (working: boolean) => void;

    constructor(
        operations: ExecutionReceipts,
        executions: SessionExecutions,
        onFinished: (sessionTarget: NativeSessionTarget) => void,
        onWorking: (working: boolean) => void,
    ) {
        this.#operations = operations;
        this.#executions = executions;
        this.#onFinished = onFinished;
        this.#onWorking = onWorking;
    }

    /** Whether any Session is working, by the same rule as each Session's status. */
    readonly #working = (): boolean =>
        [...this.#bySessionTarget.values()].some((session) => session.working() !== undefined);

    readonly hasUnsettledTurn = (sessionTarget: NativeSessionTarget): boolean =>
        this.#bySessionTarget
            .get(sessionTarget)
            ?.turns()
            .some((turn) => !this.#operations.isTerminalExecution(turn.command.commandId, sessionTarget)) ?? false;

    readonly session = (sessionTarget: NativeSessionTarget): SessionExecutionState => {
        let session = this.#bySessionTarget.get(sessionTarget);
        if (session === undefined) {
            session = new SessionExecutionState(sessionTarget, this.#operations, this.#executions);
            this.#bySessionTarget.set(sessionTarget, session);
        }
        return session;
    };

    readonly get = (commandId: string, sessionTarget: NativeSessionTarget): ActiveRuntimeTurn | undefined =>
        this.#bySessionTarget.get(sessionTarget)?.get(commandId);

    readonly start = (command: SessionPromptCommand, onQueued: () => void): ActiveRuntimeTurn => {
        const turn = this.session(command.target).start(command, onQueued);
        this.#onWorking(this.#working());
        return turn;
    };

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#bySessionTarget.get(turn.command.target)?.finish(turn);
        this.sweep();
        this.#onWorking(this.#working());
        this.#onFinished(turn.command.target);
    };

    /**
     * Whether the Session is working, and on which command: from a prompt's arrival until it ends, as admission makes
     * every later prompt wait. It states the turn that ended last, so a client that did not watch the Session knows
     * whether one ended since.
     */
    readonly status = (sessionTarget: NativeSessionTarget): SessionStatus => {
        const working = this.#bySessionTarget.get(sessionTarget)?.working();
        const status: SessionStatus =
            working === undefined ? { kind: "idle" } : { kind: "working", commandId: working.command.commandId };
        const lastTurn = this.#operations.lastEndedTurn(sessionTarget);
        return lastTurn === undefined ? status : { ...status, lastTurn };
    };

    /**
     * The turn the Session is working on, once it started, and the prompts queued behind it. How the last turn ended
     * is told only while the Session is not working.
     */
    readonly execution = (sessionTarget: NativeSessionTarget): TurnRead => {
        const session = this.#bySessionTarget.get(sessionTarget);
        const queued = (session?.turns() ?? [])
            .filter(
                (candidate) =>
                    candidate.isQueued() &&
                    !this.#operations.isTerminalExecution(candidate.command.commandId, sessionTarget),
            )
            .map((candidate) => ({
                commandId: candidate.command.commandId,
                prompt: candidate.command.prompt,
                attachments: candidate.command.attachments,
            }));
        const working = session?.working();
        if (working !== undefined) {
            return { turn: working.snapshot(), queued };
        }
        const lastTurn = this.#operations.lastTurn(sessionTarget);
        return { turn: null, queued, ...(lastTurn === undefined ? {} : { lastTurn }) };
    };

    /** Where the command stands: the receipts tell whether it arrived, started or ended, admission whether it waits. */
    readonly standing = (commandId: string, sessionTarget: NativeSessionTarget): CommandStanding => {
        const received = this.#operations.received(commandId, sessionTarget);
        switch (received.kind) {
            case "unseen":
                return { state: "unknown" };
            case "pending":
                return this.get(commandId, sessionTarget)?.isQueued() === true
                    ? { state: "queued" }
                    : { state: "preparing" };
            case "started":
                return { state: "running", startedAt: received.startedAt };
            case "settled":
                return { state: "settled" };
            default:
                return received satisfies never;
        }
    };

    readonly admitAndWait = async (turn: ActiveRuntimeTurn, waitSignal: AbortSignal): Promise<PromptDispatch> =>
        this.session(turn.command.target).admitAndWait(turn, waitSignal);

    /** Discards empty session states so the index does not grow unboundedly. */
    readonly sweep = (): void => {
        for (const [sessionTarget, session] of this.#bySessionTarget) {
            if (session.isEmpty()) {
                this.#bySessionTarget.delete(sessionTarget);
            }
        }
    };

    readonly close = async (): Promise<void> => {
        await Promise.all([...this.#bySessionTarget.values()].map((session) => session.close()));
    };
}
