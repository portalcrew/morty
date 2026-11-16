import type { ConversationCreationState } from "./conversation-creation-machine.ts";
import { composerHasMessage } from "./session-operation-rules.ts";

/**
 * The facts that decide whether the New Session page starts a conversation now. The presentation disables a control
 * and `createConversation` refuses through the same rule over the same facts, so the two cannot disagree.
 */
export interface NewConversationFacts {
    readonly connectionAvailable: boolean;
    readonly startable: boolean;
    /** The page shows the New Session draft rather than another conversation. */
    readonly draftSelected: boolean;
    readonly settingsReady: boolean;
    readonly creation: ConversationCreationState["kind"];
}

function pageCanCreate(facts: NewConversationFacts): boolean {
    return facts.connectionAvailable && facts.startable && facts.draftSelected && facts.settingsReady;
}

export function canSendFirstMessage(
    facts: NewConversationFacts,
    composer: { readonly draft: string; readonly attachmentCount: number; readonly readingAttachments: boolean },
): boolean {
    return (
        facts.creation === "draft" &&
        composerHasMessage(composer.draft, composer.attachmentCount, composer.readingAttachments) &&
        pageCanCreate(facts)
    );
}

export function canRetryFirstMessage(facts: NewConversationFacts): boolean {
    switch (facts.creation) {
        case "session-create-failed":
            return pageCanCreate(facts);
        case "draft":
        case "session-creating":
        case "draft-message-sending":
            return false;
        default:
            return facts.creation satisfies never;
    }
}
