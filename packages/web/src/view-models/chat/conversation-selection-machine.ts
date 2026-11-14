import { sameNativeSession } from "@morty-build/client/native-session";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import { type OpenMortySession, type SelectedMortySession, selectedSession } from "./open-session.ts";

export type ConversationSelectionState =
    | { readonly kind: "draft"; readonly key: string }
    /** A selected target waiting for entry prerequisites; no session request is in flight. */
    | { readonly kind: "pending"; readonly target: NativeSessionTarget }
    | { readonly kind: "loading"; readonly target: NativeSessionTarget }
    | { readonly kind: "ready"; readonly session: SelectedMortySession }
    | {
          readonly kind: "failed";
          readonly failure: "connection" | "computer" | "agent-required" | "unavailable";
          readonly message: string;
          readonly target: NativeSessionTarget;
      };

export type ConversationSelectionEvent =
    | { readonly kind: "draft-selected"; readonly key: string }
    | { readonly kind: "target-selected"; readonly target: NativeSessionTarget }
    | { readonly kind: "session-load-started" }
    | {
          readonly kind: "session-loaded";
          readonly session: OpenMortySession;
          readonly target: NativeSessionTarget;
      }
    | {
          readonly kind: "session-load-failed";
          readonly failure: "connection" | "computer" | "agent-required" | "unavailable";
          readonly message: string;
          readonly target: NativeSessionTarget;
      }
    | { readonly kind: "retry-requested" }
    | { readonly kind: "conversation-created"; readonly session: OpenMortySession };

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
            return state.kind === "loading" && sameNativeSession(state.target, event.target)
                ? { kind: "ready", session: selectedSession(event.session) }
                : state;
        case "session-load-failed":
            return (state.kind === "pending" || state.kind === "loading") &&
                sameNativeSession(state.target, event.target)
                ? { kind: "failed", failure: event.failure, message: event.message, target: event.target }
                : state;
        case "retry-requested":
            return state.kind === "failed" ? { kind: "pending", target: state.target } : state;
        case "conversation-created":
            return state.kind === "draft" ? { kind: "ready", session: selectedSession(event.session) } : state;
    }
}

export function selectedConversationTarget(state: ConversationSelectionState): NativeSessionTarget | null {
    switch (state.kind) {
        case "draft":
            return null;
        case "ready":
            return state.session.target;
        case "pending":
        case "loading":
        case "failed":
            return state.target;
    }
}
