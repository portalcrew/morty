import type { SessionPromptCommand } from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import { operationErrorCode, operationErrorMessage } from "../../infra/operation-error.ts";
import type { ReportFailure, ResolveAgent } from "../api/session-api.ts";
import type { SessionManager } from "../manager/session-manager.ts";
import type { StoredSession } from "../record/session-store.ts";
import { isWithdrawn, type PromptDispatch } from "../turn/active-turn.ts";
import { resolveSessionDirectory } from "../workspace/resolve-session-directory.ts";
import type { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";
import { applyCompleteSessionConfiguration } from "./apply-session-configuration.ts";
import { PromptArtifactError, type ReadPromptArtifact, resolvePromptArtifacts } from "./prompt-artifacts.ts";
import { type PromptLifecycle, promptLifecycle } from "./prompt-lifecycle.ts";

export interface ExecutePromptOptions {
    readonly eventProjection: PromptLifecycle;
    readonly command: SessionPromptCommand;
    /** The Session the prompt names, as this Runtime holds it. */
    readonly session: StoredSession;
    readonly resolveAgent: ResolveAgent;
    readonly readArtifact: ReadPromptArtifact;
    readonly reportFailure: ReportFailure;
    readonly directories: WorkspaceDirectoryService;
    readonly sessions: SessionManager;
    readonly attemptId: string;
    readonly epoch: string;
    /** Waits for the Session to admit the prompt, and answers how it executes. */
    readonly waitForSessionAdmission: (signal: AbortSignal) => Promise<PromptDispatch>;
    /** The prompt's own signal; aborted with a withdrawal when the prompt is cancelled before its execution begins. */
    readonly signal: AbortSignal;
}

/**
 * Admits, prepares and runs one prompt. The command starts only when the Agent session records `prompt.started`,
 * immediately before handing the work to the Agent; until then a cancellation withdraws it and a failure settles it
 * as failed before start.
 */
export async function executePrompt({
    eventProjection,
    command,
    session,
    resolveAgent,
    readArtifact,
    reportFailure,
    directories,
    sessions,
    attemptId,
    epoch,
    waitForSessionAdmission,
    signal,
}: ExecutePromptOptions): Promise<void> {
    try {
        // The directory the Session records is authorized again before the Agent uses it.
        const resolved = await resolveSessionDirectory(directories, session.cwd, signal);
        const { agent, adapter, externalizeSessionUpdate } = await resolveAgent(session.harness, signal);
        const dispatch = await waitForSessionAdmission(signal);
        // A steering prompt joins an execution the Agent already holds. Check before preparing, so a steer can never
        // replace or reconfigure the process an admitted prompt is still preparing.
        if (dispatch.kind === "steer" && !sessions.acceptsSteering(command.target, dispatch.targetCommandId)) {
            throw new AcpExecutionError("The steering target is unavailable", {}, "steering_target_unavailable");
        }
        const recovery = { kind: "interactive-only" } as const;
        const preparation = {
            adapter,
            ...(externalizeSessionUpdate === undefined ? {} : { externalizeSessionUpdate }),
            agent,
            cwd: resolved.cwd,
            target: command.target,
            signal,
            recovery,
        };
        let prepared = await sessions.prepareExecutionSession(preparation);
        // Steering cannot reconfigure a running Agent, so a steered Turn's snapshot is never
        // applied and must not gate the prompt. A member who changes a setting while a Turn runs
        // sends their follow-up with the newer snapshot, and steering folds that follow-up into
        // the Turn still running on the older settings; rejecting it loses the member's message.
        if (command.sessionConfigurations !== undefined && dispatch.kind !== "steer") {
            await applyCompleteSessionConfiguration(
                sessions,
                prepared.configOptions,
                command.sessionConfigurations,
                "ignore",
                agent,
                adapter,
                resolved.cwd,
                command.commandId,
                command.target,
                signal,
            );
            prepared = await sessions.prepareExecutionSession(preparation);
        }
        signal.throwIfAborted();
        const lifecycle = promptLifecycle(
            command,
            { harness: session.harness, directory: session.cwd },
            attemptId,
            epoch,
            dispatch,
        );
        const attachments = await resolvePromptArtifacts(readArtifact, command.attachments, signal);
        const skipped = command.attachments.length - attachments.images.length - attachments.resources.length;
        if (skipped > 0) {
            reportFailure("prompt_attachments_skipped", command.commandId, { count: skipped.toString() });
        }
        if (
            command.prompt.trim().length === 0 &&
            attachments.images.length === 0 &&
            attachments.resources.length === 0
        ) {
            throw new PromptArtifactError("prompt_attachments_unsupported", "No supported prompt content remains");
        }
        let stopReason: string;
        if (dispatch.kind === "steer") {
            await sessions.steerPrompt({
                adapter,
                ...(externalizeSessionUpdate === undefined ? {} : { externalizeSessionUpdate }),
                agent,
                commandId: command.commandId,
                cwd: resolved.cwd,
                images: attachments.images,
                lifecycle,
                prompt: command.prompt,
                resources: attachments.resources,
                target: command.target,
                signal,
                targetCommandId: dispatch.targetCommandId,
            });
            stopReason = "steered";
        } else {
            const result = await sessions.runPrompt({
                adapter,
                ...(externalizeSessionUpdate === undefined ? {} : { externalizeSessionUpdate }),
                agent,
                commandId: command.commandId,
                cwd: resolved.cwd,
                images: attachments.images,
                lifecycle,
                prompt: command.prompt,
                resources: attachments.resources,
                target: command.target,
                signal,
                recovery,
            });
            stopReason = result.stopReason;
        }

        await eventProjection.completed(command.target, command.commandId, stopReason);
    } catch (error) {
        if (isWithdrawn(signal)) {
            await eventProjection.completed(command.target, command.commandId, "cancelled");
            return;
        }
        const code = operationErrorCode(error);
        const failureCode = code === "session_operation_failed" ? "agent_execution_failed" : code;
        const failureMessage =
            code === "session_operation_failed"
                ? "The local agent could not complete the request"
                : operationErrorMessage(error);
        await eventProjection.failed(command.target, command.commandId, attemptId, failureCode, failureMessage);
        // The daemon runs detached with its stdio ignored, so a failure recorded
        // only here would leave no trace for a later bug report. The local log is
        // the durable copy; the in-band failure event above stays the live signal.
        //
        // Only the controlled code and correlation identifiers are persisted. An
        // Agent rejection can quote the prompt it refused, and local diagnostics
        // must not contain prompt text, so the Agent's free text and the cause
        // chain deliberately stay out of the log. The message still reaches the
        // user through the failure event above.
        reportFailure("session_prompt_failed", command.commandId, {
            harness: command.target.harness,
            code: failureCode,
            commandId: command.commandId,
            sessionId: command.target.sessionId,
        });
        console.error("Morty daemon command failed", error);
    }
}
