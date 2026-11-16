import { NativeSessionMap } from "@portalcrew/morty-client/native-session";
import type { NativeSessionTarget, SessionStatus } from "@portalcrew/morty-client/protocol";

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
    readonly phase: ExecutionPhase;
    readonly cancellation: Cancellation;
    readonly preparation: AbortController;
}

/**
 * The single authority for which command each Session is executing and in what phase. Every reader asks it: the
 * Session rules decide from its `activity`, a cancellation stops only the execution it names, and the Session's
 * working/idle status is derived from it. From the moment an execution begins, its cancellation is recorded here and
 * nowhere else.
 *
 * Contract: admission is the only owner of whether a Session is busy, so `begin` requires an idle Session. Each
 * transition names its command and is ignored for any other. All operations are synchronous, so a check and the
 * transition that relies on it cannot be separated by another caller.
 */
export class ActiveExecutions {
    readonly #entries = new NativeSessionMap<Execution>();
    readonly status = (sessionTarget: NativeSessionTarget): SessionStatus => {
        const execution = this.#entries.get(sessionTarget);
        return execution === undefined ? { kind: "idle" } : { commandId: execution.commandId, kind: "working" };
    };

    readonly activity = (sessionTarget: NativeSessionTarget): ExecutionActivity => {
        const execution = this.#entries.get(sessionTarget);
        return execution === undefined
            ? { kind: "idle" }
            : {
                  kind: "running",
                  commandId: execution.commandId,
                  phase: execution.phase,
                  cancellationRequested: execution.cancellation.kind === "requested",
              };
    };

    readonly executes = (sessionTarget: NativeSessionTarget, commandId: string): boolean =>
        this.#entries.get(sessionTarget)?.commandId === commandId;

    readonly agentCommand = (sessionTarget: NativeSessionTarget): string | undefined => {
        const execution = this.#entries.get(sessionTarget);
        return execution?.phase === "started" ? execution.commandId : undefined;
    };

    readonly cancellationRequested = (sessionTarget: NativeSessionTarget, commandId: string): boolean => {
        const execution = this.#entries.get(sessionTarget);
        return execution?.commandId === commandId && execution.cancellation.kind === "requested";
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
        this.#entries.set(sessionTarget, {
            commandId,
            phase: "preparing",
            cancellation: { kind: "none" },
            preparation,
        });
        return preparation.signal;
    };

    /** The Agent receives the prompt. A cancelled execution must not start. */
    readonly start = (sessionTarget: NativeSessionTarget, commandId: string): void => {
        const execution = this.#entries.get(sessionTarget);
        if (execution?.commandId !== commandId || execution.phase !== "preparing") {
            throw new Error("Only the Session's preparing execution can start");
        }
        if (execution.cancellation.kind !== "none") {
            throw new Error("A cancelled execution cannot start");
        }
        this.#entries.set(sessionTarget, { ...execution, phase: "started" });
    };

    readonly settle = (sessionTarget: NativeSessionTarget, commandId: string): void => {
        const execution = this.#entries.get(sessionTarget);
        if (execution?.commandId === commandId) {
            this.#entries.set(sessionTarget, { ...execution, phase: "settled" });
        }
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
        if (execution.phase === "preparing") {
            execution.preparation.abort(new Error("The Agent turn was cancelled before it started"));
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
        }
    };

    readonly finish = (sessionTarget: NativeSessionTarget, commandId: string): void => {
        if (this.#entries.get(sessionTarget)?.commandId !== commandId) {
            return;
        }
        this.#entries.delete(sessionTarget);
    };
}
