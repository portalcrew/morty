import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";

export interface QueuedDraftMessage {
    readonly attachments: readonly ComposerAttachment[];
    readonly commandId: string;
    readonly content: string;
    readonly summary: string;
}

export type ConversationCreationState =
    | { readonly kind: "draft" }
    | { readonly kind: "session-creating"; readonly message: QueuedDraftMessage }
    | {
          readonly kind: "session-create-failed";
          readonly error: string;
          readonly message: QueuedDraftMessage;
      }
    | { readonly kind: "draft-message-sending"; readonly message: QueuedDraftMessage };

export type ConversationCreationEvent =
    | { readonly kind: "reset" }
    | { readonly kind: "draft-message-queued"; readonly message: QueuedDraftMessage }
    | { readonly kind: "session-created"; readonly commandId: string }
    | { readonly kind: "session-create-failed"; readonly commandId: string; readonly error: string }
    /** The conversation exists and its first message now belongs to it. */
    | { readonly kind: "conversation-created"; readonly commandId: string };

function isCurrentMessage(state: ConversationCreationState, commandId: string): boolean {
    switch (state.kind) {
        case "draft":
            return false;
        case "session-creating":
        case "session-create-failed":
        case "draft-message-sending":
            return state.message.commandId === commandId;
    }
}

export function transitionConversationCreation(
    state: ConversationCreationState,
    event: ConversationCreationEvent,
): ConversationCreationState {
    switch (event.kind) {
        case "reset":
            return { kind: "draft" };
        case "draft-message-queued":
            switch (state.kind) {
                case "draft":
                case "session-create-failed":
                    return { kind: "session-creating", message: event.message };
                case "session-creating":
                case "draft-message-sending":
                    return state;
            }
            return state;
        case "session-created":
            return state.kind === "session-creating" && isCurrentMessage(state, event.commandId)
                ? { kind: "draft-message-sending", message: state.message }
                : state;
        case "session-create-failed":
            return state.kind === "session-creating" && isCurrentMessage(state, event.commandId)
                ? { error: event.error, kind: "session-create-failed", message: state.message }
                : state;
        case "conversation-created":
            // The first message now belongs to its conversation; the draft starts over.
            return state.kind === "draft-message-sending" && isCurrentMessage(state, event.commandId)
                ? { kind: "draft" }
                : state;
    }
}

export function queuedDraftMessage(state: ConversationCreationState): QueuedDraftMessage | null {
    switch (state.kind) {
        case "draft":
            return null;
        case "session-creating":
        case "session-create-failed":
        case "draft-message-sending":
            return state.message;
    }
}

/** The first message of a creation that failed, which only the creation holds until it is retried or returned. */
export function failedDraftMessage(state: ConversationCreationState): QueuedDraftMessage | null {
    switch (state.kind) {
        case "session-create-failed":
            return state.message;
        case "draft":
        case "session-creating":
        case "draft-message-sending":
            return null;
    }
}

export function conversationCreationStatus(state: ConversationCreationState): string | null {
    switch (state.kind) {
        case "draft":
            return null;
        case "session-creating":
            return "Sending message";
        case "session-create-failed":
            return "Session creation failed";
        case "draft-message-sending":
            return "Sending message";
    }
}

export function conversationCreationError(state: ConversationCreationState): string {
    switch (state.kind) {
        case "session-create-failed":
            return state.error;
        case "draft":
        case "session-creating":
        case "draft-message-sending":
            return "";
    }
}

export function conversationCreationBusy(state: ConversationCreationState): boolean {
    switch (state.kind) {
        case "session-creating":
        case "draft-message-sending":
            return true;
        case "draft":
        case "session-create-failed":
            return false;
    }
}

export function conversationComposerLocked(state: ConversationCreationState): boolean {
    switch (state.kind) {
        case "draft":
            return false;
        case "session-creating":
        case "session-create-failed":
        case "draft-message-sending":
            return true;
    }
}
