import { randomUUID } from "node:crypto";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    decodeIdentifier,
    type NativeSessionResult,
    type SessionPromptCommand,
    SessionPromptDisposition,
    type SessionPromptDispositionCommand,
} from "@morty-build/client/protocol";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];

/**
 * How an admitted prompt executes: as its own turn, or by steering the running turn of `targetCommandId`. An appended
 * prompt promoted out of the queue steers the turn it waited behind, which admission names when it admits it.
 */
export type PromptDispatch = { readonly kind: "own" } | { readonly kind: "steer"; readonly targetCommandId: string };

/**
 * Where a prompt stands in its Session's admission. Whether it started belongs to its execution receipt: the turn
 * reads that fact instead of keeping a copy of it.
 */
type TurnAdmission =
    | { readonly kind: "waiting" }
    | { readonly kind: "queued"; readonly promotion: PromiseWithResolvers<void> }
    | { readonly kind: "promoted" }
    | { readonly kind: "admitted"; readonly dispatch: PromptDispatch; readonly fromQueue: boolean };

/**
 * What cancelling a prompt asks for. Before the Session begins executing it, the prompt is withdrawn: its admission
 * and preparation are aborted, and the abort reason is the record of that withdrawal. Once the Session executes it, or
 * a steering prompt joined the execution it steers, the cancellation belongs to that execution.
 */
export type TurnCancellation =
    | { readonly kind: "withdrawn" }
    | { readonly kind: "execution"; readonly execution: string };

/** The reason a prompt's own signal is aborted when it is withdrawn before the Session began executing it. */
class PromptWithdrawal extends Error {
    constructor() {
        super("The Agent turn was cancelled before it started");
        this.name = "PromptWithdrawal";
    }
}

/** Whether `signal` was aborted because its prompt was withdrawn, not because the Runtime stopped. */
export const isWithdrawn = (signal: AbortSignal): boolean =>
    signal.aborted && signal.reason instanceof PromptWithdrawal;

export class ActiveRuntimeTurn {
    readonly command: SessionPromptCommand;
    readonly epoch = decodeIdentifier(randomUUID());
    readonly #controller: AbortController;
    readonly #finished = Promise.withResolvers<void>();
    readonly #started: () => boolean;
    readonly #startedAt: () => string | undefined;
    readonly #executing: () => boolean;
    #admission: TurnAdmission = { kind: "waiting" };

    /**
     * `started` and `startedAt` read the command's execution receipt, the single owner of whether and when the command
     * started. `executing` asks the Session whether it began executing the command.
     */
    constructor(
        command: SessionPromptCommand,
        started: () => boolean,
        startedAt: () => string | undefined,
        executing: () => boolean,
    ) {
        this.command = command;
        this.#controller = new AbortController();
        this.#started = started;
        this.#startedAt = startedAt;
        this.#executing = executing;
    }

    readonly enqueue = (): void => {
        if (this.#admission.kind !== "waiting") {
            throw new Error("Only a waiting prompt can enter the queue");
        }
        this.#admission = { kind: "queued", promotion: Promise.withResolvers<void>() };
    };

    /** Whether the prompt was admitted to its Session's queue, whatever happened to it afterwards. */
    readonly enteredQueue = (): boolean =>
        this.#admission.kind === "queued" ||
        this.#admission.kind === "promoted" ||
        (this.#admission.kind === "admitted" && this.#admission.fromQueue);

    readonly isQueued = (): boolean =>
        (this.#admission.kind === "queued" ||
            (this.#admission.kind === "admitted" &&
                this.#admission.fromQueue &&
                this.#admission.dispatch.kind === "own")) &&
        !this.#started() &&
        !this.#controller.signal.aborted;

    readonly abortRuntime = (): void => {
        this.#controller.abort();
    };

    readonly finish = (): void => {
        this.#finished.resolve();
    };

    readonly promoteQueuedPrompt = (
        command: SessionPromptDispositionCommand,
    ): "accepted" | "already-started" | "unavailable" => {
        if (
            command.commandId !== this.command.commandId ||
            !sameNativeSession(command.target, this.command.target) ||
            this.#controller.signal.aborted
        ) {
            return "unavailable";
        }
        switch (this.#admission.kind) {
            case "queued": {
                const promotion = this.#admission.promotion;
                this.#admission = { kind: "promoted" };
                promotion.resolve();
                return "accepted";
            }
            case "promoted":
                return "accepted";
            case "admitted":
                return this.#admission.dispatch.kind === "steer" ? "accepted" : "already-started";
            case "waiting":
                return "unavailable";
        }
    };

    /**
     * Fixes how the prompt executes before asynchronous Agent preparation, so a late promotion cannot change a dispatch
     * that execution has already selected.
     */
    readonly admit = (dispatch: PromptDispatch): PromptDispatch => {
        const fromQueue = this.enteredQueue();
        this.#admission = { kind: "admitted", dispatch, fromQueue };
        return dispatch;
    };

    readonly queuePromotion = (): Promise<void> | null => {
        if (this.#admission.kind === "queued") {
            return this.#admission.promotion.promise;
        }
        return this.#admission.kind === "promoted" ? Promise.resolve() : null;
    };

    /** Whether the prompt joins another turn's execution instead of owning one, so it holds no place in the queue. */
    readonly isSteering = (): boolean => {
        switch (this.#admission.kind) {
            case "waiting":
                return this.command.disposition === SessionPromptDisposition.Steer;
            case "queued":
                return false;
            case "promoted":
                return true;
            case "admitted":
                return this.#admission.dispatch.kind === "steer";
        }
    };

    /** A steering prompt joins the execution of the turn it steers; every other prompt owns its execution. */
    readonly execution = (): string =>
        this.#admission.kind === "admitted" && this.#admission.dispatch.kind === "steer"
            ? this.#admission.dispatch.targetCommandId
            : this.command.commandId;

    readonly snapshot = (): ActiveTurnSnapshot => {
        const startedAt = this.#startedAt();
        if (startedAt === undefined) {
            // Admission may not have started, or settlement may precede removal from the active index.
            return null;
        }
        return {
            commandId: decodeIdentifier(this.command.commandId),
            epoch: this.epoch,
            startedAt,
            state: "running",
        };
    };

    /**
     * Withdraws the prompt while the Session has not begun executing it; otherwise names the execution whose
     * cancellation the caller requests. Withdrawing again, or after the Runtime stopped the prompt, changes nothing.
     */
    readonly requestCancellation = (): TurnCancellation => {
        if (this.#started() || this.#executing()) {
            return { kind: "execution", execution: this.execution() };
        }
        if (!this.#controller.signal.aborted) {
            this.#controller.abort(new PromptWithdrawal());
        }
        return { kind: "withdrawn" };
    };

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    get completion(): Promise<void> {
        return this.#finished.promise;
    }
}
