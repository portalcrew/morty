import { SESSION_CLOSED_ERROR_CODE } from "@portalcrew/morty-client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { ExecutionActivity } from "../turn/active-executions.ts";
import type { SessionLifecycle } from "./session-lifecycle.ts";

/**
 * Everything this Runtime does with one Session at an instant, read from the facts' owners at once. The Session rules
 * below are the only place that decides from it, so which operation may run, whether the Session is busy, and whether
 * it is known all follow from the same reading.
 */
export interface SessionActivity {
    readonly lifecycle: SessionLifecycle;
    /** An import, fork, or history read is managing the native session. */
    readonly nativeOperation: boolean;
    readonly execution: ExecutionActivity;
    /** A prompt was accepted and has no outcome yet, whether or not its execution has begun. */
    readonly unsettledTurn: boolean;
    readonly process: {
        readonly agent: { readonly kind: "none" } | { readonly kind: "ready"; readonly backgroundActivity: boolean };
        readonly preparing: boolean;
        readonly borrowers: number;
    };
    /** Reading the record is a database read, so only the rules that need it ask. */
    readonly held: () => boolean;
}

export type ImmediateSessionOperation =
    | { readonly kind: "prepare-execution" }
    | { readonly kind: "use" }
    /** Runs a prompt in the open Session, which must not write a native session another operation is managing. */
    | { readonly kind: "prompt" }
    /** Needs the native session to itself: no import, fork, or history read may be managing it. */
    | { readonly kind: "native-exclusive" }
    /** Copies a Session's native conversation, which no accepted prompt may still be writing. */
    | { readonly kind: "fork" }
    /** Replaces the Agent process with one for another environment, so nothing may still use the current one. */
    | { readonly kind: "change-environment" }
    | { readonly kind: "steer"; readonly targetCommandId: string };

export type WaitingSessionOperation =
    | { readonly kind: "prepare" }
    | { readonly kind: "end" }
    | { readonly kind: "import" };

type ImmediateAdmission =
    | { readonly kind: "admitted" }
    | { readonly kind: "refused"; readonly error: AcpExecutionError };

export type SessionAdmission = ImmediateAdmission | { readonly kind: "wait"; readonly settled: Promise<void> };

const admitted: ImmediateAdmission = { kind: "admitted" };

const refused = (message: string, code: string): ImmediateAdmission => ({
    kind: "refused",
    error: new AcpExecutionError(message, {}, code),
});

const closedRefusal = (reason: string): ImmediateAdmission => refused(reason, SESSION_CLOSED_ERROR_CODE);
const notFound = (): ImmediateAdmission => refused("The Session was not found", "session_not_found");
const managed = (): ImmediateAdmission => refused("The native session is being managed", "session_busy");

/** From the moment a command's execution begins until it is released. */
export const isExecuting = (activity: SessionActivity): boolean => activity.execution.kind === "running";

const hasBackgroundActivity = (activity: SessionActivity): boolean =>
    activity.process.agent.kind === "ready" && activity.process.agent.backgroundActivity;

/** Whether the Session's current Agent process is in use, so no operation may replace it. */
const usesAgentProcess = (activity: SessionActivity): boolean =>
    hasBackgroundActivity(activity) ||
    isExecuting(activity) ||
    activity.process.borrowers > 0 ||
    activity.lifecycle.kind === "creating" ||
    activity.nativeOperation;

/** Whether the Session's Agent process must be kept: idle reclamation and capacity eviction leave it alone. */
export const isBusy = (activity: SessionActivity): boolean =>
    usesAgentProcess(activity) || activity.process.preparing || activity.unsettledTurn;

export const isKnownSession = (activity: SessionActivity): boolean =>
    activity.process.agent.kind === "ready" || activity.process.preparing || activity.held();

export function admitNow(activity: SessionActivity, operation: ImmediateSessionOperation): ImmediateAdmission {
    const closed = activity.lifecycle.kind === "closing" ? activity.lifecycle.reason : undefined;
    switch (operation.kind) {
        case "prepare-execution":
            if (closed !== undefined) {
                return closedRefusal(closed);
            }
            return activity.held() ? admitted : notFound();
        case "use":
            return closed === undefined ? admitted : closedRefusal(closed);
        case "prompt":
            if (closed !== undefined) {
                return closedRefusal(closed);
            }
            return activity.nativeOperation ? managed() : admitted;
        case "native-exclusive":
            return activity.nativeOperation ? managed() : admitted;
        case "fork":
            if (activity.nativeOperation) {
                return managed();
            }
            return activity.held() && (isExecuting(activity) || activity.process.preparing || activity.unsettledTurn)
                ? refused("Wait for the native session's running operation to finish", "session_busy")
                : admitted;
        case "change-environment":
            return usesAgentProcess(activity)
                ? refused(
                      "The execution environment cannot change while a conversation turn is running",
                      "session_busy",
                  )
                : admitted;
        case "steer": {
            const execution = activity.execution;
            return execution.kind === "running" &&
                execution.commandId === operation.targetCommandId &&
                execution.phase === "started" &&
                !execution.cancellationRequested
                ? admitted
                : refused("The target turn is no longer active", "steering_target_unavailable");
        }
    }
}

export function admitAfterTransitions(activity: SessionActivity, operation: WaitingSessionOperation): SessionAdmission {
    const lifecycle = activity.lifecycle;
    switch (operation.kind) {
        case "prepare":
            if (lifecycle.kind === "closing") {
                return { kind: "wait", settled: lifecycle.settled };
            }
            if (!activity.held()) {
                // A preparation that found the Session before it was archived must not revive it.
                return notFound();
            }
            return activity.nativeOperation ? managed() : admitted;
        case "end":
            return lifecycle.kind === "creating" || lifecycle.kind === "closing"
                ? { kind: "wait", settled: lifecycle.settled }
                : admitted;
        case "import":
            if (lifecycle.kind === "closing") {
                return { kind: "wait", settled: lifecycle.settled };
            }
            return activity.nativeOperation ? managed() : admitted;
    }
}
