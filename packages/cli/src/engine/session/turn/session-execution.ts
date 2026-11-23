import {
    type NativeSessionTarget,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@portalcrew/morty-client/protocol";
import { waitForSharedOperation } from "../../util/wait-for-shared-operation.ts";
import { ActiveRuntimeTurn, type PromptDispatch } from "./active-turn.ts";
import type { ExecutionReceipts } from "./execution-receipts.ts";

/** The Session execution authority's account of a command: whether the Session executes it, and is stopping it. */
export interface SessionExecutions {
    readonly executes: (sessionTarget: NativeSessionTarget, commandId: string) => boolean;
    readonly stopping: (sessionTarget: NativeSessionTarget, commandId: string) => boolean;
}

/**
 * One session's in-flight turns: FIFO admission, steering, and interaction recording. Admission is the only place
 * that decides whether the Session is working: its `working` turn is the one every later prompt waits behind. Whether
 * a turn started is read from its execution receipt.
 */
export class SessionExecutionState {
    readonly #sessionTarget: NativeSessionTarget;
    readonly #turnsByCommandId = new Map<string, ActiveRuntimeTurn>();
    readonly #operations: ExecutionReceipts;
    readonly #executions: SessionExecutions;

    constructor(sessionTarget: NativeSessionTarget, operations: ExecutionReceipts, executions: SessionExecutions) {
        this.#sessionTarget = sessionTarget;
        this.#operations = operations;
        this.#executions = executions;
    }

    readonly isEmpty = (): boolean => this.#turnsByCommandId.size === 0;

    /**
     * Places the prompt in arrival order. An appended prompt behind an earlier turn that owns an execution enters the
     * queue as it arrives, so the queue and its announcements follow arrival order whatever its preparation awaits.
     */
    readonly start = (command: SessionPromptCommand, onQueued: () => void): ActiveRuntimeTurn => {
        const turn = new ActiveRuntimeTurn(
            command,
            () => this.#operations.hasStarted(command.commandId, this.#sessionTarget),
            () => this.#operations.startedAt(command.commandId, this.#sessionTarget),
            () => this.#operations.delegation(command.commandId, this.#sessionTarget),
            () => this.#executions.executes(this.#sessionTarget, command.commandId),
            () => this.#executions.stopping(this.#sessionTarget, command.commandId),
        );
        this.#turnsByCommandId.set(command.commandId, turn);
        if (command.disposition !== SessionPromptDisposition.Steer && this.working() !== turn) {
            turn.enqueue();
            onQueued();
        }
        return turn;
    };

    /**
     * The turn the Session is working on, from its arrival, through preparation and execution, until it ends: the
     * earliest turn that owns an execution. A promoted prompt steers instead and holds no place.
     */
    readonly working = (): ActiveRuntimeTurn | undefined => {
        const owners = [...this.#turnsByCommandId.values()].filter((candidate) => !candidate.isSteering());
        // A desktop turn can begin while phone inputs wait. The native execution precedes that queue.
        return (
            owners.find((turn) => this.#executions.executes(this.#sessionTarget, turn.command.commandId)) ?? owners[0]
        );
    };

    readonly get = (commandId: string): ActiveRuntimeTurn | undefined => this.#turnsByCommandId.get(commandId);

    readonly finish = (turn: ActiveRuntimeTurn): void => {
        this.#turnsByCommandId.delete(turn.command.commandId);
        turn.finish();
    };

    readonly turns = (): readonly ActiveRuntimeTurn[] => [...this.#turnsByCommandId.values()];

    readonly close = async (): Promise<void> => {
        const turns = [...this.#turnsByCommandId.values()];
        for (const turn of turns) {
            turn.abortRuntime();
        }
        await Promise.all(turns.map((turn) => turn.completion));
    };

    /**
     * Admits the turn in arrival order. A steering prompt joins the running turn it names. An appended prompt runs
     * when no earlier turn owns an execution, and otherwise waits in the queue it entered on arrival until every earlier
     * one ended or the user promotes it to steer the turn it waits behind. Admission never refuses an appended prompt.
     */
    readonly admitAndWait = async (turn: ActiveRuntimeTurn, waitSignal: AbortSignal): Promise<PromptDispatch> => {
        const command = turn.command;
        waitSignal.throwIfAborted();
        if (command.disposition === SessionPromptDisposition.Steer) {
            return turn.admit({ kind: "steer", targetCommandId: command.targetCommandId });
        }
        for (;;) {
            waitSignal.throwIfAborted();
            const first = this.working();
            if (first === undefined || first === turn) {
                return turn.admit({ kind: "own" });
            }
            const promotion = turn.queuePromotion();
            if (promotion === null) {
                throw new Error("The queued prompt cannot be promoted");
            }
            const decision = await Promise.race([
                waitForSharedOperation(first.completion, waitSignal).then(() => "target-completed" as const),
                promotion.then(() => "promoted" as const),
            ]);
            if (decision === "promoted") {
                return turn.admit({ kind: "steer", targetCommandId: first.command.commandId });
            }
        }
    };
}
