import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { type OpenMortySession, type SelectedMortySession, selectedSession } from "./open-session.ts";

type ConversationTarget = { readonly kind: "session"; readonly identity: NativeSessionTarget };

export type ConversationSelectionState =
    | { readonly kind: "draft"; readonly key: string }
    /** A selected target waiting for entry prerequisites; no session request is in flight. */
    | { readonly kind: "pending"; readonly target: ConversationTarget }
    | { readonly kind: "loading"; readonly target: ConversationTarget }
    | {
          readonly kind: "ready";
          readonly session: SelectedMortySession;
          readonly target: ConversationTarget;
      }
    | {
          readonly kind: "failed";
          readonly failure: "connection" | "computer" | "agent-required" | "unavailable";
          readonly message: string;
          readonly target: ConversationTarget;
      };

export type ConversationSelectionEvent =
    | { readonly kind: "draft-selected"; readonly key: string }
    | { readonly kind: "target-selected"; readonly target: ConversationTarget }
    | { readonly kind: "session-load-started" }
    | {
          readonly kind: "session-loaded";
          readonly session: OpenMortySession;
          readonly target: ConversationTarget;
      }
    | {
          readonly kind: "session-load-failed";
          readonly failure: "connection" | "computer" | "agent-required" | "unavailable";
          readonly message: string;
          readonly target: ConversationTarget;
      }
    | { readonly kind: "retry-requested" }
    | { readonly kind: "conversation-created"; readonly session: OpenMortySession };

function sameTarget(left: ConversationTarget, right: ConversationTarget): boolean {
    return left.identity.harness === right.identity.harness && left.identity.sessionId === right.identity.sessionId;
}

export function transitionConversationSelection(
    state: ConversationSelectionState,
    event: ConversationSelectionEvent,
): ConversationSelectionState {
    switch (event.kind) {
        case "draft-selected":
            return { key: event.key, kind: "draft" };
        case "target-selected":
            return { kind: "pending", target: event.target };
        case "session-load-started":
            return state.kind === "pending" ? { kind: "loading", target: state.target } : state;
        case "session-loaded":
            return state.kind === "loading" && sameTarget(state.target, event.target)
                ? { kind: "ready", session: selectedSession(event.session), target: event.target }
                : state;
        case "session-load-failed":
            return (state.kind === "pending" || state.kind === "loading") && sameTarget(state.target, event.target)
                ? { kind: "failed", failure: event.failure, message: event.message, target: event.target }
                : state;
        case "retry-requested":
            return state.kind === "failed" ? { kind: "pending", target: state.target } : state;
        case "conversation-created":
            return state.kind === "draft"
                ? {
                      kind: "ready",
                      session: selectedSession(event.session),
                      target: {
                          kind: "session",
                          identity: event.session.target,
                      },
                  }
                : state;
    }
}

export function selectedConversationTarget(state: ConversationSelectionState): NativeSessionTarget | null {
    return state.kind === "draft" ? null : state.target.identity;
}
