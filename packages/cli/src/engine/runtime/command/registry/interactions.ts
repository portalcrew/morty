import type { NativeSessionTarget } from "@morty-build/client/protocol";
import {
    promptStopReason,
    type SESSION_ARCHIVE_KIND,
    SESSION_ARCHIVED_KIND,
    type SESSION_CANCEL_BEFORE_START_KIND,
    type SESSION_CANCEL_KIND,
    type SESSION_ELICITATION_RESPOND_KIND,
    SESSION_INTERACTION_ANSWERED_KIND,
    type SESSION_PERMISSION_RESPOND_KIND,
    type SESSION_PROMPT_DISPOSITION_KIND,
    SESSION_PROMPT_STEERED_KIND,
    SESSION_TURN_STOPPED_KIND,
    SESSION_TURN_WITHDRAWN_KIND,
    sessionArchivedEventCodec,
    sessionInteractionAnsweredEventCodec,
    sessionPromptSteeredEventCodec,
    sessionTurnStoppedEventCodec,
    sessionTurnWithdrawnEventCodec,
} from "@morty-build/client/protocol";
import { WebSocket } from "undici";
import { SessionError } from "../../../session/api/session-error.ts";
import { settleAbandonedTurn } from "../../../session/prompt/prompt-lifecycle.ts";
import type { CommandContext } from "../context.ts";
import type { CommandHandler } from "../definition.ts";
import { replyFailure, reportOperationFailure, send } from "../transport.ts";
import { reply, replySettledFailure, settledCommand } from "../turn-replies.ts";

/** Answers a request that waited for its Turn to end with how the Turn ended. */
async function replyStopped(
    context: CommandContext,
    {
        commandId,
        requestId,
        target,
    }: { readonly commandId: string; readonly requestId: string; readonly target: NativeSessionTarget },
): Promise<void> {
    const { operations, socket, signal, payloadEncryption } = context;
    const settled = settledCommand(operations, commandId);
    if (settled.kind === "completed") {
        if (socket.readyState === WebSocket.OPEN) {
            reply(
                socket,
                await sessionTurnStoppedEventCodec.encode(
                    {
                        commandId,
                        kind: SESSION_TURN_STOPPED_KIND,
                        requestId,
                        target,
                        stopReason: promptStopReason(settled.completion),
                    },
                    payloadEncryption,
                    signal,
                ),
            );
        }
        return;
    }
    await replySettledFailure(context, requestId, target, settled);
}

export const handleSessionCancel: CommandHandler<typeof SESSION_CANCEL_KIND> = (context, message): Promise<void> => {
    const { eventProjection, operations, sessions, sessionTurns, signal } = context;
    const { commandId, requestId, target } = message;
    const turn = sessionTurns.get(commandId, target);
    const stop = async (): Promise<void> => {
        if (turn === undefined) {
            await settleAbandonedTurn(eventProjection, operations, message);
            if (!operations.isTerminalExecution(commandId, target)) {
                await replyFailure(context, requestId, target, "turn_not_active", "The turn is not running.");
                return;
            }
        } else {
            const cancellation = turn.requestCancellation();
            if (cancellation.kind === "execution") {
                await sessions.cancelPrompt(target, cancellation.execution, signal);
            }
            await operations.settlement(commandId, target, signal);
        }
        await replyStopped(context, message);
    };
    return stop().catch(async (error: unknown) => {
        if (!signal.aborted) {
            await reportOperationFailure(context, requestId, target, error);
        }
    });
};

export const handleSessionCancelBeforeStart: CommandHandler<typeof SESSION_CANCEL_BEFORE_START_KIND> = async (
    context,
    message,
): Promise<void> => {
    const { eventProjection, operations, sessions, sessionTurns, signal, socket, payloadEncryption } = context;
    const { commandId, requestId, target } = message;
    const withdrawn = async (): Promise<void> => {
        if (socket.readyState === WebSocket.OPEN) {
            reply(
                socket,
                await sessionTurnWithdrawnEventCodec.encode(
                    { commandId, kind: SESSION_TURN_WITHDRAWN_KIND, requestId, target },
                    payloadEncryption,
                    signal,
                ),
            );
        }
    };
    const alreadyStarted = (): Promise<void> =>
        reportOperationFailure(
            context,
            requestId,
            target,
            new SessionError("turn_already_started", "The message already started and could not be withdrawn"),
        );
    if (operations.hasStarted(commandId, target)) {
        await alreadyStarted();
        return;
    }
    const turn = sessionTurns.get(commandId, target);
    if (turn === undefined) {
        const cancelled = operations.recordCancellationBeforeAdmission(commandId, target);
        const outcome =
            cancelled.kind === "unavailable" || cancelled.kind === "expired"
                ? undefined
                : cancelled.kind === "restated"
                  ? cancelled.outcome.event
                  : cancelled.outcome;
        if (
            outcome?.type === "lifecycle-metadata" &&
            outcome.payload.kind === "prompt.completed" &&
            outcome.payload.completion.kind === "cancelled"
        ) {
            if (cancelled.kind === "restated") {
                eventProjection.restateOutcome(target, cancelled.outcome);
                await withdrawn();
                return;
            }
            await eventProjection
                .recordOutcome(target, outcome)
                .then(withdrawn)
                .catch(async (error: unknown) => {
                    await reportOperationFailure(context, requestId, target, error);
                });
            return;
        }
        await reportOperationFailure(
            context,
            requestId,
            target,
            new SessionError("turn_not_active", "The command is not waiting to start"),
        );
        return;
    }
    // No await separates checking admission from requesting cancellation. A prompt the Session already began
    // executing is withdrawn by cancelling that execution: the cancellation is recorded at once, so it never
    // starts, and the reply below follows from the command's progress alone.
    const cancellation = turn.requestCancellation();
    if (cancellation.kind === "execution") {
        void sessions.cancelPrompt(target, cancellation.execution, signal).catch((error: unknown) => {
            console.error("Morty daemon could not stop a withdrawn prompt's execution", error);
        });
    }
    await operations
        .progress(commandId, target, signal)
        .then(async (progress) => {
            if (progress === "started") {
                await alreadyStarted();
                return;
            }
            const settled = settledCommand(operations, commandId);
            if (settled.kind !== "completed") {
                await replySettledFailure(context, requestId, target, settled);
            } else if (settled.completion.kind === "cancelled" && !settled.completion.started) {
                await withdrawn();
            } else {
                await alreadyStarted();
            }
        })
        .catch(() => undefined);
};

export const handleSessionArchive: CommandHandler<typeof SESSION_ARCHIVE_KIND> = (context, message): Promise<void> => {
    const { sessions, signal, socket, payloadEncryption } = context;
    return sessions
        .archiveSession(message.target, signal)
        .then(async () => {
            send(
                socket,
                await sessionArchivedEventCodec.encode(
                    { kind: SESSION_ARCHIVED_KIND, requestId: message.requestId, target: message.target },
                    payloadEncryption,
                    signal,
                ),
            );
        })
        .catch(async (error: unknown) => {
            signal.throwIfAborted();
            await reportOperationFailure(context, message.requestId, message.target, error);
        });
};

export const handlePromptDisposition: CommandHandler<typeof SESSION_PROMPT_DISPOSITION_KIND> = async (
    context,
    message,
): Promise<void> => {
    const { diagnostics, operations, sessionTurns, signal, socket, payloadEncryption } = context;
    const { commandId, requestId, target } = message;
    const turn = sessionTurns.get(commandId, target);
    // The ledger's terminal outcome distinguishes a completed steer from a message that ran on its own.
    const outcome = operations.hasStarted(commandId, target) ? operations.outcome(commandId) : undefined;
    if (
        outcome?.type === "lifecycle-metadata" &&
        outcome.payload.kind === "prompt.completed" &&
        outcome.payload.completion.kind === "steered"
    ) {
        if (socket.readyState === WebSocket.OPEN) {
            reply(
                socket,
                await sessionPromptSteeredEventCodec.encode(
                    { commandId, kind: SESSION_PROMPT_STEERED_KIND, requestId, target },
                    payloadEncryption,
                    signal,
                ),
            );
        }
        return;
    }
    const result = turn?.promoteQueuedPrompt(message) ?? "unavailable";
    if (result === "accepted") {
        // The steered prompt is answered once it starts inside the running Turn.
        await operations
            .progress(commandId, target, signal)
            .then(async (progress) => {
                if (progress === "started") {
                    if (socket.readyState === WebSocket.OPEN) {
                        reply(
                            socket,
                            await sessionPromptSteeredEventCodec.encode(
                                { commandId, kind: SESSION_PROMPT_STEERED_KIND, requestId, target },
                                payloadEncryption,
                                signal,
                            ),
                        );
                    }
                    return;
                }
                const settled = settledCommand(operations, commandId);
                if (settled.kind !== "completed") {
                    await replySettledFailure(context, requestId, target, settled);
                    return;
                }
                await replyFailure(
                    context,
                    requestId,
                    target,
                    "turn_not_active",
                    "The message ended before it was steered.",
                );
            })
            .catch(() => undefined);
        return;
    }
    const started = result === "already-started" || operations.hasStarted(commandId, target);
    const error = started
        ? new SessionError("turn_already_started", "The message already left the queue and could not be steered")
        : new SessionError("turn_not_active", "The message is no longer waiting to be steered");
    diagnostics.daemonDiagnostic("session_prompt_disposition_failed", commandId, {
        code: error.code,
        commandId,
        harness: target.harness,
        sessionId: target.sessionId,
    });
    await reportOperationFailure(context, requestId, target, error);
};

export const handlePermissionRespond: CommandHandler<typeof SESSION_PERMISSION_RESPOND_KIND> = (
    context,
    message,
): Promise<void> => {
    const { sessions, signal, socket, payloadEncryption } = context;
    const { interactionId, requestId, target } = message;
    return sessions
        .respondPermission(message)
        .then(async () => {
            if (socket.readyState === WebSocket.OPEN) {
                reply(
                    socket,
                    await sessionInteractionAnsweredEventCodec.encode(
                        { interactionId, kind: SESSION_INTERACTION_ANSWERED_KIND, requestId, target },
                        payloadEncryption,
                        signal,
                    ),
                );
            }
        })
        .catch(async (error: unknown) => {
            signal.throwIfAborted();
            await reportOperationFailure(context, requestId, target, error);
        });
};

export const handleElicitationRespond: CommandHandler<typeof SESSION_ELICITATION_RESPOND_KIND> = (
    context,
    message,
): Promise<void> => {
    const { sessions, signal, socket, payloadEncryption } = context;
    const { interactionId, requestId, target } = message;
    return sessions
        .respondElicitation(message)
        .then(async () => {
            if (socket.readyState === WebSocket.OPEN) {
                reply(
                    socket,
                    await sessionInteractionAnsweredEventCodec.encode(
                        { interactionId, kind: SESSION_INTERACTION_ANSWERED_KIND, requestId, target },
                        payloadEncryption,
                        signal,
                    ),
                );
            }
        })
        .catch(async (error: unknown) => {
            signal.throwIfAborted();
            await reportOperationFailure(context, requestId, target, error);
        });
};
