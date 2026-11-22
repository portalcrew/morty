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
      };

export type ConversationCreationEvent =
    | { readonly kind: "draft-message-queued"; readonly message: QueuedDraftMessage }
    | { readonly kind: "session-create-failed"; readonly commandId: string; readonly error: string };

/** Whether the draft is still creating the Session for this message, so the page follows that Session. */
export function createsSessionFor(
    state: ConversationCreationState,
    commandId: string,
): state is Extract<ConversationCreationState, { readonly kind: "session-creating" }> {
    return state.kind === "session-creating" && state.message.commandId === commandId;
}

export function transitionConversationCreation(
    state: ConversationCreationState,
    event: ConversationCreationEvent,
): ConversationCreationState {
    switch (event.kind) {
        case "draft-message-queued":
            switch (state.kind) {
                case "draft":
                case "session-create-failed":
                    return { kind: "session-creating", message: event.message };
                case "session-creating":
                    return state;
            }
            return state;
        case "session-create-failed":
            return createsSessionFor(state, event.commandId)
                ? { error: event.error, kind: "session-create-failed", message: state.message }
                : state;
    }
}

export function queuedDraftMessage(state: ConversationCreationState): QueuedDraftMessage | null {
    switch (state.kind) {
        case "draft":
            return null;
        case "session-creating":
        case "session-create-failed":
            return state.message;
    }
}

export function failedDraftMessage(state: ConversationCreationState): QueuedDraftMessage | null {
    switch (state.kind) {
        case "session-create-failed":
            return state.message;
        case "draft":
        case "session-creating":
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
    }
}

export function conversationCreationError(state: ConversationCreationState): string {
    switch (state.kind) {
        case "session-create-failed":
            return state.error;
        case "draft":
        case "session-creating":
            return "";
    }
}

export function conversationCreationBusy(state: ConversationCreationState): boolean {
    switch (state.kind) {
        case "session-creating":
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
            return true;
    }
}
