import { createHash, randomUUID } from "node:crypto";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    type CommandDelivery,
    decodeKnownSessionEventPayload,
    isPromptTerminal,
    type LastTurnOutcome,
    type LifecycleMetadata,
    type NativeSessionTarget,
    type PromptTerminalLifecycle,
    promptStopReason,
    type SessionEventPayload,
    type SessionLiveEvent,
} from "@morty-build/client/protocol";
import { z } from "zod";
import type { CommandFate, CommandLedgerTable, LedgerCommand } from "../../storage/session/command-ledger-table.ts";

export type RuntimeExecutionReceipt =
    | Readonly<{
          attemptId: string;
          commandId: string;
          kind: "accepted";
      }>
    | Readonly<{
          attemptId: string;
          commandId: string;
          kind: "duplicate";
          // Whether the original command has ended, as its receipt records it.
          state: "settled" | "unsettled";
      }>
    | { readonly kind: "conflict" }
    | { readonly kind: "expired" }
    // The Session did not admit the new command; nothing is recorded, so its identifier stays unused.
    | { readonly kind: "refused" };

/**
 * An outcome a restart publishes: one the restart itself settles (a command it interrupted), or one the previous
 * process had already recorded, which is published again for clients that missed it.
 */
export type RecoveredOutcome =
    | {
          readonly kind: "recorded";
          readonly target: NativeSessionTarget;
          readonly event: SessionEventPayload;
          readonly recordedAt: string;
      }
    | { readonly kind: "restated"; readonly target: NativeSessionTarget; readonly outcome: RestatedOutcome };

/**
 * An outcome the ledger already holds, restated for clients that missed it. It keeps the time it was recorded, which
 * identifies when the command ended; undefined when the ledger no longer keeps it.
 */
export interface RestatedOutcome {
    readonly event: SessionEventPayload;
    readonly recordedAt: string | undefined;
}

/**
 * A settled turn whose Agent reported the user message the turn recorded, as the ledger keeps it. A replayed history
 * places the turn's lifecycle around that message.
 */
export interface SettledTurn {
    readonly attemptId: string;
    readonly outcome: Extract<LifecycleMetadata, { readonly kind: "prompt.completed" | "prompt.failed" }> & {
        readonly messageId: string;
    };
    /** When the turn started, when the ledger kept it, else when it ended. */
    readonly startedAt: string;
    readonly recordedAt: string;
}

/** A transition the ledger records for a command: it started, or it settled. */
export type CommandProgress = "started" | "settled";

/** What a cancellation before admission found: a cancellation it recorded, or an outcome recorded earlier. */
export type CancellationBeforeAdmission =
    | { readonly kind: "recorded"; readonly outcome: SessionEventPayload }
    | { readonly kind: "restated"; readonly outcome: RestatedOutcome }
    | { readonly kind: "unavailable" }
    | { readonly kind: "expired" };

const isStarted = (fate: CommandFate): boolean => fate.kind === "started" || fate.kind === "settled-after-start";

const isUnsettled = (fate: CommandFate): fate is UnsettledFate => fate.kind === "pending" || fate.kind === "started";

type UnsettledFate = Extract<CommandFate, { readonly kind: "pending" | "started" }>;
type SettledCommandFate = Exclude<CommandFate, UnsettledFate>;

/**
 * How an unsettled command settles, from the terminal event it recorded: a completion as cancelled before it started
 * is a cancellation. The stored outcome is that event's content-free form.
 */
function settledFate(fate: UnsettledFate, terminal: PromptTerminalLifecycle, outcome: string): SettledCommandFate {
    if (fate.kind === "started") {
        return { kind: "settled-after-start", startedAt: fate.startedAt, outcome };
    }
    return terminal.kind === "prompt.completed" && terminal.completion.kind === "cancelled"
        ? { kind: "cancelled", outcome }
        : { kind: "settled-before-start", outcome };
}

/** What a command identifier means to one Session: whether it may run, and what happened to it. */
type CommandStanding =
    // Nothing is recorded: the command may run.
    | { readonly kind: "unseen" }
    // Another Session owns the identifier.
    | { readonly kind: "foreign" }
    // A restart failed the command before it started: it may run again.
    | { readonly kind: "retryable" }
    // The ledger answers for the command, unsettled or with its outcome, and it does not run again.
    | { readonly kind: "retained"; readonly command: LedgerCommand }
    // The command started, and its outcome is no longer kept.
    | { readonly kind: "expired"; readonly commandHash: string }
    // The command was cancelled before it started, and its outcome is no longer kept.
    | { readonly kind: "cancelled" };

function commandStanding(command: LedgerCommand | undefined, sessionTarget: NativeSessionTarget): CommandStanding {
    if (command === undefined) {
        return { kind: "unseen" };
    }
    if (!sameNativeSession(command.target, sessionTarget)) {
        return { kind: "foreign" };
    }
    const fate = command.fate;
    switch (fate.kind) {
        case "pending":
        case "started":
            return { kind: "retained", command };
        case "cancelled":
            return fate.outcome === null ? { kind: "cancelled" } : { kind: "retained", command };
        case "interrupted-before-start":
            return { kind: "retryable" };
        case "settled-before-start":
            return { kind: "retained", command };
        case "settled-after-start":
            return fate.outcome === null
                ? { kind: "expired", commandHash: command.commandHash }
                : { kind: "retained", command };
        default:
            return fate satisfies never;
    }
}

const cancelledBeforeStartOutcome = (commandId: string): SessionEventPayload => ({
    type: "lifecycle-metadata",
    payload: { kind: "prompt.completed", commandId, completion: { kind: "cancelled", started: false } },
});

/** A stored outcome: the event as recorded, with its recording time. */
const storedOutcome = (stored: string): RestatedOutcome | undefined => {
    const parsed: unknown = JSON.parse(stored);
    const event = decodeKnownSessionEventPayload(parsed);
    return event === null
        ? undefined
        : { event, recordedAt: z.object({ recordedAt: z.string() }).parse(parsed).recordedAt };
};

/**
 * The Runtime's answers about the commands it admitted, read from the command ledger, which alone records what
 * became of each command.
 */
export class ExecutionReceipts {
    readonly #ledger: CommandLedgerTable;
    /**
     * The terminal events this process recorded with the Agent's own failure text. That text can quote user input, so
     * it never enters the ledger, which keeps the content-free form; clients of this process still read the original.
     */
    readonly #agentOutcomes = new Map<string, string>();
    /**
     * Settlements reached while this process shuts down. They are artifacts of stopping, not of the commands, so the
     * ledger keeps the commands unsettled and the next process reports that the restart interrupted them.
     */
    readonly #shutdownSettlements = new Map<string, CommandFate>();
    /** Requests waiting for a command's next transition; each listener hears every transition until removed. */
    readonly #watchers = new Map<string, Set<(progress: CommandProgress) => void>>();
    #closing = false;

    constructor(ledger: CommandLedgerTable) {
        this.#ledger = ledger;
    }

    readonly #withShutdownSettlement = (command: LedgerCommand): LedgerCommand => {
        const fate = this.#shutdownSettlements.get(command.commandId);
        return fate === undefined ? command : { ...command, fate };
    };
    readonly #read = (commandId: string): LedgerCommand | undefined => {
        const command = this.#ledger.read(commandId);
        return command === undefined ? undefined : this.#withShutdownSettlement(command);
    };
    readonly #standing = (commandId: string, sessionTarget: NativeSessionTarget): CommandStanding =>
        commandStanding(this.#read(commandId), sessionTarget);
    /** The outcome clients read for a settled command: what this process recorded, else the ledger's form. */
    readonly #outcome = ({ commandId, fate }: LedgerCommand): string | undefined => {
        if (isUnsettled(fate) || fate.outcome === null) {
            return undefined;
        }
        return this.#agentOutcomes.get(commandId) ?? fate.outcome;
    };
    readonly #notify = (commandId: string, progress: CommandProgress): void => {
        for (const listener of [...(this.#watchers.get(commandId) ?? [])]) {
            listener(progress);
        }
    };
    /**
     * Settles an unsettled command with `settled`, whose stored outcome is `outcome`. `agentOutcome` is the outcome with
     * the Agent's text, when it differs.
     */
    readonly #settle = (
        commandId: string,
        settled: SettledCommandFate,
        outcome: string,
        agentOutcome?: string,
    ): void => {
        if (agentOutcome !== undefined) {
            this.#agentOutcomes.set(commandId, agentOutcome);
        }
        if (this.#closing) {
            this.#shutdownSettlements.set(commandId, settled);
        } else {
            for (const dropped of this.#ledger.settle(commandId, settled.kind, outcome)) {
                this.#agentOutcomes.delete(dropped);
            }
        }
        this.#notify(commandId, "settled");
    };

    readonly beginShutdown = (): void => {
        this.#closing = true;
    };
    /** Waits for the first transition of the command that `accepts`; the waiter is released when `signal` aborts. */
    readonly #transition = (
        commandId: string,
        accepts: (progress: CommandProgress) => boolean,
        signal: AbortSignal,
    ): Promise<CommandProgress> =>
        new Promise<CommandProgress>((resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            const watchers = this.#watchers.get(commandId) ?? new Set();
            const release = (): void => {
                signal.removeEventListener("abort", aborted);
                watchers.delete(listener);
                if (watchers.size === 0) {
                    this.#watchers.delete(commandId);
                }
            };
            const listener = (progress: CommandProgress): void => {
                if (accepts(progress)) {
                    release();
                    resolve(progress);
                }
            };
            const aborted = (): void => {
                release();
                reject(signal.reason);
            };
            watchers.add(listener);
            this.#watchers.set(commandId, watchers);
            signal.addEventListener("abort", aborted, { once: true });
        });
    /** Where the command stands now, or its next transition: `started` once it started, `settled` once it has ended. */
    readonly progress = async (
        commandId: string,
        sessionTarget: NativeSessionTarget,
        signal: AbortSignal,
    ): Promise<CommandProgress> => {
        if (this.isTerminalExecution(commandId, sessionTarget)) {
            return "settled";
        }
        if (this.hasStarted(commandId, sessionTarget)) {
            return "started";
        }
        return await this.#transition(commandId, () => true, signal);
    };
    /** Resolves once the command has ended. */
    readonly settlement = async (
        commandId: string,
        sessionTarget: NativeSessionTarget,
        signal: AbortSignal,
    ): Promise<void> => {
        if (!this.isTerminalExecution(commandId, sessionTarget)) {
            await this.#transition(commandId, (progress) => progress === "settled", signal);
        }
    };
    readonly outcome = (commandId: string): SessionEventPayload | undefined => this.restatedOutcome(commandId)?.event;
    /** The outcome the ledger keeps for the command, with the time it was recorded. */
    readonly restatedOutcome = (commandId: string): RestatedOutcome | undefined => {
        const command = this.#read(commandId);
        const outcome = command === undefined ? undefined : this.#outcome(command);
        return outcome === undefined ? undefined : storedOutcome(outcome);
    };
    /** The command's delivery as the ledger knows it; another Session's command reads as unknown. */
    readonly delivery = (commandId: string, sessionTarget: NativeSessionTarget): CommandDelivery => {
        const standing = this.#standing(commandId, sessionTarget);
        switch (standing.kind) {
            case "unseen":
            case "foreign":
                return { state: "unknown" };
            case "expired":
                return { state: "expired" };
            case "cancelled":
                // A command that never started has no result to lose: it stays cancelled.
                return { state: "completed", stopReason: "cancelled" };
            case "retryable":
            case "retained":
                break;
            default:
                return standing satisfies never;
        }
        const command = this.#read(commandId);
        if (command === undefined || isUnsettled(command.fate)) {
            return { state: "accepted" };
        }
        const outcome = this.outcome(commandId);
        if (outcome?.type !== "lifecycle-metadata" || !isPromptTerminal(outcome.payload)) {
            return { state: "expired" };
        }
        switch (outcome.payload.kind) {
            case "prompt.completed":
                return { state: "completed", stopReason: promptStopReason(outcome.payload.completion) };
            case "prompt.failed":
            case "prompt.failed-before-start":
                return { code: outcome.payload.code, state: "failed" };
        }
    };
    /**
     * How the Session's most recently admitted turn ended. Commands that never started (queued, or reserved for
     * cancellation) are not turns, unless they failed before starting. A steering command that completed as `steered`
     * joined the turn it steered, which reports for both; a steer not known to have joined (it failed, or a restart
     * interrupted it) keeps its own outcome. Undefined while the latest turn runs or its outcome is no longer kept.
     */
    readonly lastTurn = (sessionTarget: NativeSessionTarget): LastTurnOutcome | undefined => {
        let last: { readonly commandId: string; readonly outcome: SessionEventPayload | undefined } | undefined;
        for (const stored of this.#ledger.session(sessionTarget)) {
            const command = this.#withShutdownSettlement(stored);
            const outcome = this.outcome(command.commandId);
            const payload = outcome?.type === "lifecycle-metadata" ? outcome.payload : undefined;
            const failedBeforeStart = payload?.kind === "prompt.failed-before-start";
            const steered = payload?.kind === "prompt.completed" && payload.completion.kind === "steered";
            const kept = command.fate.kind === "started" || outcome !== undefined;
            if (kept && (isStarted(command.fate) || failedBeforeStart) && !steered) {
                last = { commandId: command.commandId, outcome };
            }
        }
        const outcome = last?.outcome;
        if (last === undefined || outcome?.type !== "lifecycle-metadata" || !isPromptTerminal(outcome.payload)) {
            return undefined;
        }
        switch (outcome.payload.kind) {
            case "prompt.completed":
                return {
                    commandId: last.commandId,
                    state: "completed",
                    stopReason: promptStopReason(outcome.payload.completion),
                };
            case "prompt.failed":
            case "prompt.failed-before-start":
                return {
                    code: outcome.payload.code,
                    commandId: last.commandId,
                    message: outcome.payload.message,
                    state: "failed",
                };
        }
    };
    /** When the Session's running command started. */
    readonly startedAt = (commandId: string, sessionTarget: NativeSessionTarget): string | undefined => {
        const command = this.#read(commandId);
        return command !== undefined &&
            sameNativeSession(command.target, sessionTarget) &&
            command.fate.kind === "started"
            ? command.fate.startedAt
            : undefined;
    };
    /** The Session's settled turns, in admission order, whose outcomes the ledger keeps with their user message. */
    readonly settledTurns = (sessionTarget: NativeSessionTarget): readonly SettledTurn[] =>
        this.#ledger.session(sessionTarget).flatMap((command): SettledTurn[] => {
            const outcome = this.restatedOutcome(command.commandId);
            const event = outcome?.event;
            if (
                outcome?.recordedAt === undefined ||
                event?.type !== "lifecycle-metadata" ||
                (event.payload.kind !== "prompt.completed" && event.payload.kind !== "prompt.failed") ||
                event.payload.messageId === undefined
            ) {
                return [];
            }
            const fate = this.#withShutdownSettlement(command).fate;
            return [
                {
                    attemptId: command.attemptId,
                    outcome: { ...event.payload, messageId: event.payload.messageId },
                    recordedAt: outcome.recordedAt,
                    startedAt: fate.kind === "settled-after-start" ? fate.startedAt : outcome.recordedAt,
                },
            ];
        });
    /** A command that started stays started after its outcome is no longer kept. */
    readonly hasStarted = (commandId: string, sessionTarget: NativeSessionTarget): boolean => {
        const standing = this.#standing(commandId, sessionTarget);
        switch (standing.kind) {
            case "unseen":
            case "foreign":
            case "cancelled":
            case "retryable":
                return false;
            case "expired":
                return true;
            case "retained":
                return isStarted(standing.command.fate);
            default:
                return standing satisfies never;
        }
    };

    /**
     * Reserves an unseen command for cancellation before a delayed prompt can claim its identity. A command that
     * already has an outcome keeps it, and the outcome is restated rather than recorded again.
     */
    readonly recordCancellationBeforeAdmission = (
        commandId: string,
        sessionTarget: NativeSessionTarget,
    ): CancellationBeforeAdmission => {
        const standing = this.#standing(commandId, sessionTarget);
        switch (standing.kind) {
            case "foreign":
                return { kind: "unavailable" };
            case "retryable":
            case "retained": {
                const outcome = this.restatedOutcome(commandId);
                return outcome === undefined ? { kind: "unavailable" } : { kind: "restated", outcome };
            }
            case "expired":
                // Execution is known, but its outcome is unavailable; never invent a cancellation result.
                return { kind: "expired" };
            case "cancelled":
                return {
                    kind: "restated",
                    outcome: { event: cancelledBeforeStartOutcome(commandId), recordedAt: undefined },
                };
            case "unseen":
                break;
            default:
                return standing satisfies never;
        }
        const outcome = cancelledBeforeStartOutcome(commandId);
        // The identifier belongs to the cancellation, so a later prompt conflicts rather than executing.
        const commandHash = createHash("sha256")
            .update(JSON.stringify({ commandId, kind: "session.cancel-before-start", sessionTarget }))
            .digest("hex");
        for (const dropped of this.#ledger.admitCancelled(
            { attemptId: randomUUID(), commandHash, commandId, target: sessionTarget },
            JSON.stringify({ ...outcome, recordedAt: new Date().toISOString() }),
        )) {
            this.#agentOutcomes.delete(dropped);
        }
        return { kind: "recorded", outcome };
    };
    /**
     * The ledger follows each command's recorded lifecycle. `prompt.started` is recorded where the command is handed
     * to the Agent, so the started mark and the event clients see are one transition; a terminal event settles the
     * command. Nothing else marks a command started.
     */
    readonly record = (event: SessionLiveEvent): void => {
        if (event.type !== "lifecycle-metadata") {
            return;
        }
        const payload = event.payload;
        if (payload.kind === "prompt.started") {
            // A start reported after settlement does not reopen the execution.
            this.#ledger.start(payload.commandId, event.recordedAt);
            this.#notify(payload.commandId, "started");
            return;
        }
        if (!isPromptTerminal(payload)) {
            return;
        }
        const fate = this.#read(payload.commandId)?.fate;
        if (fate === undefined || !isUnsettled(fate)) {
            return;
        }
        const outcome = { type: "lifecycle-metadata", payload, recordedAt: event.recordedAt };
        if (payload.kind === "prompt.completed") {
            const stored = JSON.stringify(outcome);
            this.#settle(payload.commandId, settledFate(fate, payload, stored), stored);
            return;
        }
        const contentFree = JSON.stringify({
            ...outcome,
            payload: { ...payload, message: "The local Agent could not complete the request" },
        });
        this.#settle(payload.commandId, settledFate(fate, payload, contentFree), contentFree, JSON.stringify(outcome));
    };
    readonly recover = (): readonly RecoveredOutcome[] => {
        const recovered: RecoveredOutcome[] = [];
        for (const command of this.#ledger.all()) {
            const fate = command.fate;
            if (!isUnsettled(fate)) {
                // The previous process recorded this outcome; publishing it again restates that fact.
                const restated = fate.outcome === null ? undefined : storedOutcome(fate.outcome);
                if (restated !== undefined) {
                    recovered.push({ kind: "restated", target: command.target, outcome: restated });
                }
                continue;
            }
            const event: SessionEventPayload = {
                type: "lifecycle-metadata",
                payload:
                    fate.kind === "started"
                        ? {
                              kind: "prompt.failed",
                              commandId: command.commandId,
                              attemptId: command.attemptId,
                              code: "runtime_restarted",
                              message: "The local runtime restarted while this request was running",
                          }
                        : {
                              kind: "prompt.failed-before-start",
                              commandId: command.commandId,
                              code: "runtime_restarted",
                              message: "The local runtime restarted before this request started",
                          },
            };
            const recordedAt = new Date().toISOString();
            recovered.push({ kind: "recorded", target: command.target, event, recordedAt });
            const stored = JSON.stringify({ ...event, recordedAt });
            // The restart, not the command, ended a command that had not started, so its identifier may run again.
            this.#settle(
                command.commandId,
                fate.kind === "started"
                    ? { kind: "settled-after-start", startedAt: fate.startedAt, outcome: stored }
                    : { kind: "interrupted-before-start", outcome: stored },
                stored,
            );
        }
        return recovered;
    };

    /**
     * Claims a command's identifier for the Session. A known identifier is answered from the ledger; a new command is
     * recorded only when `admits` accepts it in the same step, so a command the Session refuses leaves no record.
     */
    readonly claimExecution = (
        commandId: string,
        sessionTarget: NativeSessionTarget,
        commandJson: string,
        admits: () => boolean,
    ): RuntimeExecutionReceipt => {
        const commandHash = createHash("sha256").update(commandJson).digest("hex");
        const standing = this.#standing(commandId, sessionTarget);
        switch (standing.kind) {
            case "foreign":
            case "cancelled":
                return { kind: "conflict" };
            case "retained":
                if (standing.command.commandHash !== commandHash) {
                    return { kind: "conflict" };
                }
                return {
                    attemptId: standing.command.attemptId,
                    commandId,
                    kind: "duplicate",
                    state: isUnsettled(standing.command.fate) ? "unsettled" : "settled",
                };
            case "expired":
                return standing.commandHash === commandHash ? { kind: "expired" } : { kind: "conflict" };
            case "retryable":
            case "unseen":
                break;
            default:
                return standing satisfies never;
        }
        if (!admits()) {
            return { kind: "refused" };
        }
        const attemptId = randomUUID();
        const identity = { attemptId, commandHash, commandId, target: sessionTarget };
        if (standing.kind === "retryable") {
            // A restart failed it before it started: the admission replaces that failure.
            this.#ledger.readmitInterrupted(identity);
        } else {
            this.#ledger.admit(identity);
        }
        return { attemptId, commandId, kind: "accepted" };
    };

    /** Only commands without a terminal result can still be cancelled. */
    readonly findUnsettledAttemptId = (commandId: string, sessionTarget: NativeSessionTarget): string | null => {
        const command = this.#read(commandId);
        return command !== undefined && sameNativeSession(command.target, sessionTarget) && isUnsettled(command.fate)
            ? command.attemptId
            : null;
    };

    readonly isTerminalExecution = (commandId: string, sessionTarget: NativeSessionTarget): boolean => {
        const command = this.#read(commandId);
        return command !== undefined && sameNativeSession(command.target, sessionTarget) && !isUnsettled(command.fate);
    };

    readonly close = (): void => {
        this.#watchers.clear();
        this.#agentOutcomes.clear();
        this.#shutdownSettlements.clear();
    };
}
