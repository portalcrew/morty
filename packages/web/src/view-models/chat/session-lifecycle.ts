import type { MortyPermissionAnswer } from "@morty-build/client";
import type {
    SessionElicitationAwaitingCompletionEvent,
    SessionElicitationRequestedEvent,
    SessionLiveEvent,
    SessionPermissionRequestedEvent,
    SessionPermissionResolvedEvent,
} from "@morty-build/client/protocol";
import type { SessionInteraction } from "./session-pane-types.ts";

// The Session pane reads Morty lifecycle metadata only through this module, so
// a lifecycle protocol change is absorbed here instead of across pane workflows.

type LifecycleMetadata = Extract<SessionLiveEvent, { readonly type: "lifecycle-metadata" }>["payload"];
/** How far the native session's owner has taken a command the Computer handed it: holding it, or running it. */
export type DelegationStage = Extract<LifecycleMetadata, { readonly kind: "prompt.delegated" }>["stage"];
type LifecycleEvent<Kind extends LifecycleMetadata["kind"]> = Extract<
    LifecycleMetadata,
    { readonly kind: Kind; readonly event: unknown }
>["event"];

/** What a lifecycle event means for the Session pane. */
export type SessionLifecycleFact =
    | { readonly kind: "interaction-requested"; readonly interaction: SessionInteraction }
    | {
          readonly kind: "permission-resolved";
          readonly interactionId: string;
          readonly answer: MortyPermissionAnswer;
      }
    | {
          readonly kind: "elicitation-resolved";
          readonly interactionId: string;
          readonly action: LifecycleEvent<"session.elicitation.resolved">["action"];
      }
    | { readonly kind: "queue-changed" }
    | { readonly kind: "turn-started"; readonly commandId: string }
    /** The Computer handed the command to the native session's owner, such as the Codex app, which runs it or not. */
    | { readonly kind: "turn-delegated"; readonly commandId: string; readonly stage: DelegationStage }
    | { readonly kind: "turn-completed"; readonly commandId: string; readonly steered: boolean }
    | { readonly kind: "turn-failed"; readonly commandId: string; readonly code: string; readonly message: string }
    /** The event changes nothing the pane tracks outside the message projection. */
    | { readonly kind: "none" };

export function sessionLifecycleFact(payload: LifecycleMetadata): SessionLifecycleFact {
    switch (payload.kind) {
        case "session.permission.requested":
        case "session.elicitation.requested":
            return { kind: "interaction-requested", interaction: requestedInteraction(payload.event) };
        case "session.permission.resolved":
            return {
                kind: "permission-resolved",
                interactionId: payload.event.interactionId,
                answer: permissionAnswer(payload.event),
            };
        case "session.elicitation.resolved":
            return {
                kind: "elicitation-resolved",
                interactionId: payload.event.interactionId,
                action: payload.event.action,
            };
        case "session.queue.changed":
            return { kind: "queue-changed" };
        case "prompt.requested":
            return { kind: "none" };
        case "prompt.started":
            return { kind: "turn-started", commandId: payload.commandId };
        case "prompt.delegated":
            return { kind: "turn-delegated", commandId: payload.commandId, stage: payload.stage };
        case "prompt.completed":
            return {
                kind: "turn-completed",
                commandId: payload.commandId,
                steered: payload.completion.kind === "steered",
            };
        case "prompt.failed":
        case "prompt.failed-before-start":
            return { kind: "turn-failed", commandId: payload.commandId, code: payload.code, message: payload.message };
        default:
            return payload satisfies never;
    }
}

/** The pending interaction a live request or an interaction snapshot describes. */
export function requestedInteraction(
    event:
        | SessionPermissionRequestedEvent
        | SessionElicitationRequestedEvent
        | SessionElicitationAwaitingCompletionEvent,
): SessionInteraction {
    switch (event.kind) {
        case "session.permission.requested":
            return { kind: "permission", permission: { ...event, state: { kind: "pending" } } };
        case "session.elicitation.requested": {
            const { commandId: _commandId, kind: _kind, ...elicitation } = event;
            return { kind: "elicitation", elicitation: { ...elicitation, state: { kind: "pending" } } };
        }
        case "session.elicitation.awaiting-completion": {
            const { commandId: _commandId, kind: _kind, ...elicitation } = event;
            return {
                kind: "elicitation",
                elicitation: { ...elicitation, mode: "url", state: { kind: "submitted" } },
            };
        }
        default:
            return event satisfies never;
    }
}

/** What a permission was decided to be, whichever option was chosen. */
function permissionAnswer(event: SessionPermissionResolvedEvent): MortyPermissionAnswer {
    return event.outcome === "selected" ? { outcome: "selected", optionId: event.optionId } : { outcome: "cancelled" };
}
