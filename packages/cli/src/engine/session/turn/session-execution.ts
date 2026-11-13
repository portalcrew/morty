import {
    type NativeSessionTarget,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { ActiveRuntimeTurn, type PromptDispatch } from "./active-turn.ts";
import type { ExecutionReceipts } from "./execution-receipts.ts";

/** Whether the Session began executing the command and still holds it, as its execution authority answers. */
export type SessionExecutes = (sessionTarget: NativeSessionTarget, commandId: string) => boolean;

const waitForTurnCompletion = (turn: ActiveRuntimeTurn, waitSignal: AbortSignal): Promise<void> => {
    waitSignal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (
            result: { readonly kind: "completed" } | { readonly kind: "failed"; readonly error: unknown },
        ): void => {
            if (settled) {
                return;
            }
            settled = true;
            waitSignal.removeEventListener("abort", onAbort);
            if (result.kind === "completed") {
                resolve();
            } else {
                reject(result.error);
            }
        };
        const onAbort = (): void => finish({ error: waitSignal.reason, kind: "failed" });
        waitSignal.addEventListener("abort", onAbort, { once: true });
        void turn.completion.then(
            () => finish({ kind: "completed" }),
            (error: unknown) => finish({ error, kind: "failed" }),
        );
    });
};

/**
 * One session's in-flight turns: FIFO admission, steering, and interaction recording. Admission is the only place
 * that decides whether the Session is busy; whether a turn started is read from its execution receipt.
 */
export class SessionExecutionState {
    readonly #sessionTarget: NativeSessionTarget;
    readonly #turnsByCommandId = new Map<string, ActiveRuntimeTurn>();
    readonly #operations: ExecutionReceipts;
    readonly #executes: SessionExecutes;

    constructor(sessionTarget: NativeSessionTarget, operations: ExecutionReceipts, executes: SessionExecutes) {
        this.#sessionTarget = sessionTarget;
        this.#operations = operations;
        this.#executes = executes;
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
            () => this.#executes(this.#sessionTarget, command.commandId),
        );
        this.#turnsByCommandId.set(command.commandId, turn);
        if (command.disposition !== SessionPromptDisposition.Steer && this.#head() !== turn) {
            turn.enqueue();
            onQueued();
        }
        return turn;
    };

    /** The earliest turn that owns an execution: a promoted prompt steers instead and holds no place. */
    readonly #head = (): ActiveRuntimeTurn | undefined =>
        [...this.#turnsByCommandId.values()].find((candidate) => !candidate.isSteering());

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
            const first = this.#head();
            if (first === undefined || first === turn) {
                return turn.admit({ kind: "own" });
            }
            const promotion = turn.queuePromotion();
            if (promotion === null) {
                throw new Error("The queued prompt cannot be promoted");
            }
            const decision = await Promise.race([
                waitForTurnCompletion(first, waitSignal).then(() => "target-completed" as const),
                promotion.then(() => "promoted" as const),
            ]);
            if (decision === "promoted") {
                return turn.admit({ kind: "steer", targetCommandId: first.command.commandId });
            }
        }
    };
}
