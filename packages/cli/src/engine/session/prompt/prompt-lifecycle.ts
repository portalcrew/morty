import { NativeSessionMap, sameNativeSession } from "@morty-build/client/native-session";
import type {
    ContentBlock,
    NativeSessionTarget,
    PromptExecutionContext,
    SessionCancelCommand,
    SessionEventPayload,
    SessionLiveEvent,
    SessionPromptCommand,
} from "@morty-build/client/protocol";
import { isPromptTerminal, SessionPromptDisposition } from "@morty-build/client/protocol";
import type { SessionEventSink } from "../api/session-api.ts";
import { SessionError } from "../api/session-error.ts";
import type { PromptDispatch } from "../turn/active-turn.ts";
import type { ExecutionReceipts, RestatedOutcome } from "../turn/execution-receipts.ts";
import { isTextPromptResourceMediaType } from "./prompt-artifacts.ts";

function promptContent(command: SessionPromptCommand): readonly ContentBlock[] {
    const content: ContentBlock[] = [];
    if (command.prompt.length > 0) {
        content.push({ text: command.prompt, type: "text" });
    }
    for (const attachment of command.attachments) {
        content.push(
            attachment.kind === "image"
                ? {
                      byteLength: attachment.byteLength,
                      imageKey: attachment.contentKey,
                      mimeType: attachment.mimeType,
                      type: "external_image",
                      uri: attachment.uri,
                  }
                : {
                      byteLength: attachment.byteLength,
                      encoding: isTextPromptResourceMediaType(attachment.mimeType) ? "text" : "binary",
                      mimeType: attachment.mimeType,
                      resourceKey: attachment.contentKey,
                      type: "external_resource",
                      uri: attachment.uri,
                  },
        );
    }
    return content;
}

/** The lifecycle metadata the Agent session records when it starts this claimed command. */
export function promptLifecycle(
    command: SessionPromptCommand,
    context: PromptExecutionContext,
    attemptId: string,
    epoch: string,
    dispatch: PromptDispatch,
): {
    readonly attemptId: string;
    readonly content: readonly ContentBlock[];
    readonly disposition: string;
    readonly epoch: string;
    readonly context: PromptExecutionContext;
    readonly targetCommandId?: string;
} {
    return {
        attemptId,
        content: promptContent(command),
        epoch,
        context,
        ...(dispatch.kind === "steer"
            ? { disposition: SessionPromptDisposition.Steer, targetCommandId: dispatch.targetCommandId }
            : { disposition: SessionPromptDisposition.Append }),
    };
}

/** Whether a command started or settled, as its execution receipt records it. */
type ExecutionProgress = Pick<ExecutionReceipts, "findUnsettledAttemptId" | "hasStarted" | "isTerminalExecution">;

export class PromptLifecycle {
    readonly #sink: SessionEventSink;
    /** Terminal events held until their command's admission and execution state are released. */
    readonly #terminal = new Map<string, SessionLiveEvent>();
    readonly #publications = new NativeSessionMap<SessionLiveEvent[]>();
    readonly #executions: ExecutionProgress;

    readonly #recordLifecycle: (sessionTarget: NativeSessionTarget, event: SessionEventPayload) => Promise<void>;
    readonly #append: (
        sessionTarget: NativeSessionTarget,
        event: SessionEventPayload,
        recordedAt?: string,
    ) => SessionLiveEvent;
    constructor(
        sink: SessionEventSink,
        recordLifecycle: (sessionTarget: NativeSessionTarget, event: SessionEventPayload) => Promise<void>,
        append: (
            sessionTarget: NativeSessionTarget,
            event: SessionEventPayload,
            recordedAt?: string,
        ) => SessionLiveEvent,
        executions: ExecutionProgress,
    ) {
        this.#recordLifecycle = recordLifecycle;
        this.#append = append;
        this.#executions = executions;
        this.#sink = sink;
    }

    readonly record = (recorded: SessionLiveEvent): void => {
        const sessionTarget = recorded.target;
        if (recorded.type === "lifecycle-metadata" && isPromptTerminal(recorded.payload)) {
            // Publish termination after prompt admission and execution state are settled.
            this.#terminal.set(recorded.payload.commandId, recorded);
            const pending = this.#publications.get(sessionTarget) ?? [];
            pending.push(recorded);
            this.#publications.set(sessionTarget, pending);
            return;
        }
        this.#publishInOrder(recorded);
    };

    /** Publishes after the Session's held terminal events, so clients receive its events in order. */
    readonly #publishInOrder = (event: SessionLiveEvent): void => {
        const pending = this.#publications.get(event.target);
        if (pending !== undefined) {
            pending.push(event);
        } else {
            this.#sink.publish(event);
        }
    };

    readonly publishTerminal = (sessionTarget: NativeSessionTarget, commandId: string): void => {
        const event = this.#terminal.get(commandId);
        if (event !== undefined && sameNativeSession(event.target, sessionTarget)) {
            this.#terminal.delete(commandId);
            const pending = this.#publications.get(sessionTarget) ?? [];
            while (pending.length > 0) {
                const next = pending[0];
                if (next === undefined) {
                    break;
                }
                if (
                    next.type === "lifecycle-metadata" &&
                    "commandId" in next.payload &&
                    this.#terminal.has(next.payload.commandId)
                ) {
                    break;
                }
                pending.shift();
                this.#sink.publish(next);
            }
            if (pending.length === 0) {
                this.#publications.delete(sessionTarget);
            }
        }
    };

    readonly recordOutcome = async (sessionTarget: NativeSessionTarget, event: SessionEventPayload): Promise<void> => {
        if (event.type !== "lifecycle-metadata" || !("commandId" in event.payload)) {
            return;
        }
        await this.#recordLifecycle(sessionTarget, event);
        this.publishTerminal(sessionTarget, event.payload.commandId);
    };

    /**
     * Publishes again an outcome a receipt already holds, for clients that missed it. The restatement is marked, so
     * status notifications do not take it for a new outcome, and it does not settle the receipt again. It keeps the
     * time the outcome was recorded.
     */
    readonly restateOutcome = (sessionTarget: NativeSessionTarget, { event, recordedAt }: RestatedOutcome): void => {
        if (event.type !== "lifecycle-metadata" || !("commandId" in event.payload)) {
            return;
        }
        const restated = this.#append(sessionTarget, event, recordedAt);
        this.#publishInOrder({
            ...restated,
            mortyMetadata: { ...restated.mortyMetadata, restated: true },
        });
    };

    readonly queueChanged = async (sessionTarget: NativeSessionTarget, commandId: string): Promise<void> => {
        await this.#recordLifecycle(sessionTarget, {
            type: "lifecycle-metadata",
            payload: { changedByCommandId: commandId, kind: "session.queue.changed" },
        });
    };

    readonly completed = async (
        sessionTarget: NativeSessionTarget,
        commandId: string,
        stopReason: string,
    ): Promise<void> => {
        if (this.#executions.isTerminalExecution(commandId, sessionTarget)) {
            return;
        }
        await this.#recordLifecycle(sessionTarget, {
            type: "lifecycle-metadata",
            payload: {
                kind: "prompt.completed",
                commandId,
                stopReason,
                ...(this.#executions.hasStarted(commandId, sessionTarget) ? {} : { execution: "not-started" as const }),
            },
        });
    };

    /**
     * Settles a failed command; whether it failed before or after starting is its receipt's fact. The unsettled
     * receipt, not the queue registration, admits the failure: a turn that ended without recording its terminal
     * event has already left the queue, and its abandonment must still settle it.
     */
    readonly failed = async (
        sessionTarget: NativeSessionTarget,
        commandId: string,
        attemptId: string,
        code: string,
        message: string,
    ): Promise<void> => {
        if (this.#executions.findUnsettledAttemptId(commandId, sessionTarget) === null) {
            return;
        }
        await this.#recordLifecycle(sessionTarget, {
            type: "lifecycle-metadata",
            payload: this.#executions.hasStarted(commandId, sessionTarget)
                ? { kind: "prompt.failed", attemptId, commandId, code, message }
                : { kind: "prompt.failed-before-start", commandId, code, message },
        });
    };
}

export async function settleAbandonedTurn(
    projection: PromptLifecycle,
    operations: ExecutionReceipts,
    cancellation: SessionCancelCommand,
): Promise<void> {
    const cancelled = operations.recordCancellationBeforeAdmission(cancellation.commandId, cancellation.target);
    switch (cancelled.kind) {
        case "recorded":
            await projection.recordOutcome(cancellation.target, cancelled.outcome);
            return;
        case "restated":
            projection.restateOutcome(cancellation.target, cancelled.outcome);
            return;
        case "expired":
            throw new SessionError(
                "command_result_expired",
                "The command executed but its result is no longer retained",
            );
        case "unavailable":
            break;
    }
    const attemptId = operations.findUnsettledAttemptId(cancellation.commandId, cancellation.target);
    if (attemptId === null) {
        console.warn("Morty daemon ignored cancellation for an inactive turn");
        return;
    }
    await projection.failed(
        cancellation.target,
        cancellation.commandId,
        attemptId,
        "agent_execution_abandoned",
        "The local Agent execution was abandoned before it completed",
    );
    projection.publishTerminal(cancellation.target, cancellation.commandId);
}
