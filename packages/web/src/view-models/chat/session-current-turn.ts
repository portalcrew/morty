import { decodeIdentifier } from "@morty-build/client/protocol";
import type { DelegationStage } from "./session-lifecycle.ts";

// The turn the Session treats as current: the command the service reported running or accepted from this page, its
// turn id and when its work started, or how the last reported turn ended. It records only what the service reported.
// Which report is newer than another is decided by the Session's execution state (`session-execution.ts`); these
// transitions only say what one report does to the turn.

export type TurnFailure = { readonly code: string; readonly message: string };

export type CurrentTurn =
    | {
          readonly kind: "idle";
          /** The last failure the service reported for a turn, reported until another turn starts or is submitted. */
          readonly failure: (TurnFailure & { readonly commandId: string }) | null;
      }
    | {
          readonly kind: "current";
          readonly commandId: string;
          readonly turnId: string;
          readonly startedAt: number;
          /**
           * How far the native session's owner has taken the command when the Computer handed it there instead of
           * running it, or null when the Computer reported no handoff.
           */
          readonly delegation: DelegationStage | null;
      };

export type CurrentTurnEvent =
    /** This page submits a new turn, so the failure reported for an earlier one no longer describes the Session. */
    | { readonly kind: "new-turn-submitted" }
    /**
     * The service accepted this page's submission of a new turn, dated by `startedAt`, when this browser sent it,
     * until the Computer reports when the turn started.
     */
    | { readonly kind: "accepted"; readonly commandId: string; readonly turnId: string; readonly startedAt: number }
    /**
     * The service reports the command running; it replaces any other current command. `startedAt` is when the Computer
     * started it.
     */
    | {
          readonly kind: "running";
          readonly commandId: string;
          readonly turnId: string;
          readonly startedAt: number;
      }
    /** The Computer handed the command to the native session's owner, which reached `stage` with it at `at`. */
    | { readonly kind: "delegated"; readonly commandId: string; readonly stage: DelegationStage; readonly at: number }
    /** The service reports the command's turn ended; `failure` explains a failed one. */
    | { readonly kind: "ended"; readonly commandId: string; readonly failure: TurnFailure | null }
    /** Nothing runs any more, as when the Session closed or a reconnect found no running turn. */
    | { readonly kind: "nothing-running" }
    /**
     * With nothing running, the service reports how its last started command ended, as when a pane opens or
     * reconnects after missing that turn's live outcome. `failure` explains a failed one.
     */
    | { readonly kind: "last-turn-reported"; readonly commandId: string; readonly failure: TurnFailure | null };

export const idleTurn: CurrentTurn = { kind: "idle", failure: null };

function isCurrent(turn: CurrentTurn, commandId: string): turn is Extract<CurrentTurn, { readonly kind: "current" }> {
    return turn.kind === "current" && turn.commandId === commandId;
}

function endedTurn(commandId: string, failure: TurnFailure | null): CurrentTurn {
    return { kind: "idle", failure: failure === null ? null : { commandId, ...failure } };
}

export function transitionCurrentTurn(turn: CurrentTurn, event: CurrentTurnEvent): CurrentTurn {
    switch (event.kind) {
        case "new-turn-submitted":
            return turn.kind === "idle" && turn.failure !== null ? { ...turn, failure: null } : turn;
        case "accepted":
            // Another command the service reports running stays current.
            if (turn.kind === "current") {
                return turn.commandId === event.commandId ? { ...turn, turnId: decodeIdentifier(event.turnId) } : turn;
            }
            return {
                kind: "current",
                commandId: event.commandId,
                turnId: decodeIdentifier(event.turnId),
                startedAt: event.startedAt,
                delegation: null,
            };
        case "running":
            return {
                kind: "current",
                commandId: decodeIdentifier(event.commandId),
                turnId: decodeIdentifier(event.turnId),
                // A command the native session's owner runs started when the owner took it.
                startedAt:
                    isCurrent(turn, event.commandId) && turn.delegation === "started"
                        ? turn.startedAt
                        : event.startedAt,
                delegation: isCurrent(turn, event.commandId) ? turn.delegation : null,
            };
        case "delegated":
            // The owner never gives a started command back to its queue, whatever order the reports arrive in. Its
            // work started when the owner took it, not when the Computer handed it over.
            if (!isCurrent(turn, event.commandId) || turn.delegation === "started") {
                return turn;
            }
            return event.stage === "started"
                ? { ...turn, delegation: "started", startedAt: event.at }
                : { ...turn, delegation: "queued" };
        case "ended":
            return isCurrent(turn, event.commandId) ? endedTurn(event.commandId, event.failure) : turn;
        case "nothing-running":
            // Learning that nothing runs cannot resolve an earlier turn failure.
            return turn.kind === "idle" ? turn : idleTurn;
        case "last-turn-reported":
            // A different command the service reported running since stays current.
            return turn.kind === "current" && turn.commandId !== event.commandId
                ? turn
                : endedTurn(event.commandId, event.failure);
        default:
            return event satisfies never;
    }
}

/** Whether only the native session's owner can stop the current turn, because it took the command into its own turn. */
export function ownerRunsTurn(turn: CurrentTurn): boolean {
    return turn.kind === "current" && turn.delegation === "started";
}

/**
 * What the pane says about the current turn: waiting in the native session owner's queue, or working since its work
 * started, there or here. Nothing while the turn waits for the user's input.
 */
export type WorkingIndicator =
    | { readonly kind: "queued-in-owner" }
    | { readonly kind: "working"; readonly startedAt: number; readonly inOwner: boolean };

export function workingIndicator(turn: CurrentTurn, waitingForInput: boolean): WorkingIndicator | null {
    if (waitingForInput || turn.kind !== "current") {
        return null;
    }
    return turn.delegation === "queued"
        ? { kind: "queued-in-owner" }
        : { kind: "working", startedAt: turn.startedAt, inOwner: turn.delegation === "started" };
}

/** The command the service accepted as the running turn, with that turn's id. */
export function acceptedTurn(turn: CurrentTurn): { readonly commandId: string; readonly turnId: string } | null {
    return turn.kind === "current" ? { commandId: turn.commandId, turnId: turn.turnId } : null;
}
