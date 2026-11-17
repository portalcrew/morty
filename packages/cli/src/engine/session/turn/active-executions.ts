import { NativeSessionMap } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget } from "@portalcrew/morty-client/protocol";
import type { ExecutionReceipts } from "./execution-receipts.ts";

type ExecutionPhase = "preparing" | "started" | "settled";

/**
 * One try at ending a cancelled execution. A stop that fails leaves the cancellation requested but nothing stopping,
 * so the next cancellation tries again instead of inheriting the failure.
 */
type StopAttempt = { readonly kind: "stopping"; readonly completion: Promise<void> } | { readonly kind: "failed" };

type Cancellation = { readonly kind: "none" } | { readonly kind: "requested"; readonly attempt: StopAttempt };

export type ExecutionActivity =
    | { readonly kind: "idle" }
    | {
          readonly kind: "running";
          readonly commandId: string;
          readonly phase: ExecutionPhase;
          readonly cancellationRequested: boolean;
      };

interface Execution {
    readonly commandId: string;
    readonly cancellation: Cancellation;
    readonly preparation: AbortController;
}

/**
 * Which command each Session is executing, and that execution's cancellation and preparation. Every reader asks it:
 * the Session rules decide from its `activity`, and a cancellation stops only the execution it names. From the moment
 * an execution begins, its cancellation is recorded here and nowhere else. How far the command went is its execution
 * receipt's: the phase is read from there, never kept here.
 *
 * Contract: admission is the only owner of whether a Session is busy, so `begin` requires an idle Session. Each
 * transition names its command and is ignored for any other. All operations are synchronous, so a check and the
 * transition that relies on it cannot be separated by another caller.
 */
export class ActiveExecutions {
    readonly #entries = new NativeSessionMap<Execution>();
    readonly #received: ExecutionReceipts["received"];
    readonly #onStopChanged: (sessionTarget: NativeSessionTarget, commandId: string, stopping: boolean) => void;

    /**
     * `onStopChanged` hears each time the Computer begins, or fails, to stop a started execution; a beginning is heard
     * before the stop runs, so it precedes whatever stopping records. Before its start a command is no turn of the
     * Session, and once it settled its terminal event has told how it ended.
     */
    constructor(
        received: ExecutionReceipts["received"],
        onStopChanged: (sessionTarget: NativeSessionTarget, commandId: string, stopping: boolean) => void,
    ) {
        this.#received = received;
        this.#onStopChanged = onStopChanged;
    }

    readonly #phase = (sessionTarget: NativeSessionTarget, commandId: string): ExecutionPhase => {
        const received = this.#received(commandId, sessionTarget);
        switch (received.kind) {
            case "unseen":
            case "pending":
                return "preparing";
            case "started":
                return "started";
            case "settled":
                return "settled";
            default:
                return received satisfies never;
        }
    };

    readonly activity = (sessionTarget: NativeSessionTarget): ExecutionActivity => {
        const execution = this.#entries.get(sessionTarget);
        return execution === undefined
            ? { kind: "idle" }
            : {
                  kind: "running",
                  commandId: execution.commandId,
                  phase: this.#phase(sessionTarget, execution.commandId),
                  cancellationRequested: execution.cancellation.kind === "requested",
              };
    };

    readonly executes = (sessionTarget: NativeSessionTarget, commandId: string): boolean =>
        this.#entries.get(sessionTarget)?.commandId === commandId;

    readonly agentCommand = (sessionTarget: NativeSessionTarget): string | undefined => {
        const execution = this.#entries.get(sessionTarget);
        return execution !== undefined && this.#phase(sessionTarget, execution.commandId) === "started"
            ? execution.commandId
            : undefined;
    };

    readonly cancellationRequested = (sessionTarget: NativeSessionTarget, commandId: string): boolean => {
        const execution = this.#entries.get(sessionTarget);
        return execution?.commandId === commandId && execution.cancellation.kind === "requested";
    };

    /** Whether a stop of the named execution is under way: requested, and its latest attempt has not failed. */
    readonly stopping = (sessionTarget: NativeSessionTarget, commandId: string): boolean => {
        const execution = this.#entries.get(sessionTarget);
        return (
            execution?.commandId === commandId &&
            execution.cancellation.kind === "requested" &&
            execution.cancellation.attempt.kind === "stopping"
        );
    };

    readonly cancellation = (sessionTarget: NativeSessionTarget): Promise<void> | undefined => {
        const cancellation = this.#entries.get(sessionTarget)?.cancellation;
        return cancellation?.kind === "requested" && cancellation.attempt.kind === "stopping"
            ? cancellation.attempt.completion.then(
                  () => undefined,
                  () => undefined,
              )
            : undefined;
    };

    readonly begin = (sessionTarget: NativeSessionTarget, commandId: string): AbortSignal => {
        if (this.#entries.has(sessionTarget)) {
            throw new Error("A Session executes one command at a time");
        }
        const preparation = new AbortController();
        this.#entries.set(sessionTarget, { commandId, cancellation: { kind: "none" }, preparation });
        return preparation.signal;
    };

    /**
     * Records a cancellation of the named execution at once and asks `stop` to end it, one attempt at a time: a
     * cancellation while a stop is under way shares it, and one after a stop failed asks again. Another command's
     * cancellation, or one for an idle Session, has nothing to stop. A cancelled execution that has not started never
     * starts, and its preparation is aborted.
     */
    readonly cancel = (
        sessionTarget: NativeSessionTarget,
        commandId: string,
        stop: () => Promise<void>,
    ): Promise<void> => {
        const execution = this.#entries.get(sessionTarget);
        if (execution?.commandId !== commandId) {
            return Promise.resolve();
        }
        if (execution.cancellation.kind === "requested" && execution.cancellation.attempt.kind === "stopping") {
            return execution.cancellation.attempt.completion;
        }
        const completion = Promise.withResolvers<void>();
        this.#entries.set(sessionTarget, {
            ...execution,
            cancellation: { kind: "requested", attempt: { kind: "stopping", completion: completion.promise } },
        });
        const phase = this.#phase(sessionTarget, commandId);
        if (phase === "preparing") {
            execution.preparation.abort(new Error("The Agent turn was cancelled before it started"));
        }
        if (phase === "started") {
            this.#onStopChanged(sessionTarget, commandId, true);
        }
        void (async () => await stop())().then(completion.resolve, (error: unknown) => {
            this.#stopFailed(sessionTarget, commandId, completion.promise);
            completion.reject(error);
        });
        return completion.promise;
    };

    /** Marks the attempt failed, unless the execution has moved on, so the next cancellation asks again. */
    readonly #stopFailed = (sessionTarget: NativeSessionTarget, commandId: string, attempt: Promise<void>): void => {
        const execution = this.#entries.get(sessionTarget);
        if (
            execution?.commandId === commandId &&
            execution.cancellation.kind === "requested" &&
            execution.cancellation.attempt.kind === "stopping" &&
            execution.cancellation.attempt.completion === attempt
        ) {
            this.#entries.set(sessionTarget, {
                ...execution,
                cancellation: { kind: "requested", attempt: { kind: "failed" } },
            });
            if (this.#phase(sessionTarget, commandId) === "started") {
                this.#onStopChanged(sessionTarget, commandId, false);
            }
        }
    };

    readonly finish = (sessionTarget: NativeSessionTarget, commandId: string): void => {
        if (this.#entries.get(sessionTarget)?.commandId !== commandId) {
            return;
        }
        this.#entries.delete(sessionTarget);
    };
}
