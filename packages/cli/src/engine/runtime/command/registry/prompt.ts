import {
    type SESSION_PROMPT_KIND,
    SessionPromptDisposition,
    sessionPromptAcceptedEventCodec,
} from "@portalcrew/morty-client/protocol";
import { WebSocket } from "undici";
import { executePrompt } from "../../../session/prompt/execute-prompt.ts";
import type { CommandHandler } from "../definition.ts";
import { replyFailure } from "../transport.ts";
import { reply, replySettledFailure, settledCommand } from "../turn-replies.ts";

export const handleSessionPrompt: CommandHandler<typeof SESSION_PROMPT_KIND> = async (
    context,
    message,
): Promise<void> => {
    const session = context.sessions.findSessions([message.target])[0];
    if (session === undefined) {
        await replyFailure(
            context,
            message.requestId,
            message.target,
            "session_not_found",
            "The Session was not found",
        );
        return;
    }
    // A steer joins a running turn, so the Session admits it only while the Agent runs the turn it names. An
    // appended prompt is always admitted: the Session runs or queues it.
    // The Turn's durable intent excludes the reply address, so a retry from another request is the same command.
    const { requestId: _requestId, ...intent } = message;
    const receipt = context.operations.claimExecution(
        message.commandId,
        message.target,
        JSON.stringify(intent),
        () =>
            message.disposition === SessionPromptDisposition.Append ||
            context.sessions.acceptsSteering(message.target, message.targetCommandId),
    );
    if (receipt.kind === "refused") {
        await replyFailure(
            context,
            message.requestId,
            message.target,
            "steering_target_unavailable",
            "The turn to steer is not running.",
        );
        return;
    }
    if (receipt.kind === "conflict") {
        await replyFailure(
            context,
            message.requestId,
            message.target,
            "command_identity_conflict",
            "This command identifier was already used for a different request.",
        );
        return;
    }
    const { commandId, requestId, target } = message;
    // A prompt is answered once, at the first of: it entered the queue, it started, or it ended without starting. The
    // answer states the standing the Computer holds at that moment, with the log position where it holds.
    let answered = false;
    let answer: Promise<void> = Promise.resolve();
    const answerAdmitted = (): boolean => {
        if (answered) {
            return true;
        }
        const admitted = context.standings.admitted(commandId, target);
        if (admitted === null) {
            return false;
        }
        answered = true;
        if (context.socket.readyState === WebSocket.OPEN) {
            answer = sessionPromptAcceptedEventCodec
                .encode(
                    { kind: "session.prompt.accepted", requestId, target, commandId, ...admitted },
                    context.payloadEncryption,
                    context.signal,
                )
                .then((encoded) => reply(context.socket, encoded))
                .catch((error: unknown) => {
                    if (!context.signal.aborted) {
                        console.error("Morty daemon could not send prompt acceptance", error);
                        context.socket.close(4008, "Prompt acceptance failed");
                    }
                });
        }
        return true;
    };
    if (receipt.kind === "duplicate") {
        // A retry of a command still preparing is answered where the command itself is: once it starts or ends.
        if (!answerAdmitted()) {
            await context.operations
                .progress(commandId, target, context.signal)
                .then(answerAdmitted)
                .catch(() => undefined);
        }
        await answer;
        const outcome = receipt.state === "settled" ? context.operations.restatedOutcome(commandId) : undefined;
        if (outcome !== undefined) {
            context.eventProjection.restateOutcome(target, outcome);
        }
        return;
    }
    if (receipt.kind === "expired") {
        await replyFailure(
            context,
            message.requestId,
            message.target,
            "command_result_expired",
            "This command already started. Its execution result is no longer available; it will not run again.",
        );
        return;
    }
    const queueChanged = (): void => {
        void context.eventProjection.queueChanged(target, commandId).catch((error: unknown) => {
            console.error("Could not record queue change", error);
        });
    };
    // A prompt behind a running turn enters the queue as it arrives, so the queue follows arrival order.
    const turn = context.sessionTurns.start(message, () => {
        queueChanged();
        answerAdmitted();
    });
    const ended = async (): Promise<void> => {
        if (answered) {
            return;
        }
        const settled = settledCommand(context.operations, commandId);
        if (settled.kind === "completed") {
            answerAdmitted();
            return;
        }
        answered = true;
        await replySettledFailure(context, requestId, target, settled);
    };
    const waiting = new AbortController();
    context.operations
        .progress(commandId, target, AbortSignal.any([waiting.signal, context.signal]))
        .then((progress) => {
            if (progress === "started") {
                answerAdmitted();
            }
        })
        .catch(() => undefined);
    // The active Session owns the Turn across relay reconnects; admission must not wait for its completion.
    void executePrompt({
        eventProjection: context.eventProjection,
        command: message,
        session,
        resolveAgent: context.resolveAgent,
        readArtifact: async (attachment, signal) => {
            const artifact = await context.externalContent.read(
                message.target,
                `morty-content:${attachment.kind}:${attachment.contentKey}`,
                signal,
            );
            if (artifact === null) {
                throw new Error("The prompt attachment is unavailable");
            }
            return { bytes: artifact.bytes, path: artifact.path };
        },
        reportFailure: context.diagnostics.daemonDiagnostic,
        directories: context.directories,
        sessions: context.sessions,
        attemptId: receipt.attemptId,
        waitForSessionAdmission: (signal) => context.sessionTurns.admitAndWait(turn, signal),
        signal: turn.signal,
    })
        .catch((error: unknown) => {
            console.error("Morty daemon turn failed", error);
        })
        .then(async () => {
            waiting.abort();
            try {
                await ended();
                await answer;
            } finally {
                context.sessionTurns.finish(turn);
                context.eventProjection.publishTerminal(message.target, message.commandId);
                if (turn.enteredQueue()) {
                    queueChanged();
                }
            }
        })
        .catch((error: unknown) => {
            console.error("Morty daemon could not finish the turn", error);
        });
};
