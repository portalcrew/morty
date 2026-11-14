import type { ConversationCreationState } from "./conversation-creation-machine.ts";
import { composerHasMessage } from "./session-operation-rules.ts";

/**
 * The facts that decide whether the New Session page starts a conversation now. The presentation disables a control
 * and `createConversation` refuses through the same rule over the same facts, so the two cannot disagree.
 */
export interface NewConversationFacts {
    /** The network and the Computer are available, as the connection header reports. */
    readonly connectionAvailable: boolean;
    /** Entry, pairing and the Computer's Agents let this page start a Session. */
    readonly startable: boolean;
    /** The page shows the New Session draft rather than another conversation. */
    readonly draftSelected: boolean;
    /** The Agent and working directory a new Session starts with are loaded. */
    readonly settingsReady: boolean;
    readonly creation: ConversationCreationState["kind"];
}

/** Creating a Session needs the draft page, ready to start one, with its settings loaded and its Computer reachable. */
function pageCanCreate(facts: NewConversationFacts): boolean {
    return facts.connectionAvailable && facts.startable && facts.draftSelected && facts.settingsReady;
}

/** Sending the composer's message starts a new Session. One first message is in creation at a time. */
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

/**
 * Retrying a first message whose Session could not be created submits that same message again, whatever the
 * composer holds now.
 */
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
