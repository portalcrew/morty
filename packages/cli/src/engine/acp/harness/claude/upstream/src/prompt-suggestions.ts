// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";

type PromptSuggestionsUpdate = Extract<
    SessionNotification["update"],
    { readonly sessionUpdate: "prompt_suggestions_update" }
>;

export class PromptSuggestions {
    private published: string | null = null;
    private expected = false;

    resultArrived(): void {
        this.expected = true;
    }

    /**
     * `working`: Claude already runs another turn, such as a prompt queued before the result. ACP discards a
     * prediction that no longer follows the conversation.
     */
    suggested(raw: string, working: boolean): PromptSuggestionsUpdate | undefined {
        if (!this.expected) {
            return undefined;
        }
        this.expected = false;
        if (working) {
            return undefined;
        }
        return this.publish(raw.trim() || null);
    }

    /** A prompt spent the prediction, or a reset dropped the transcript it came from. */
    clear(): PromptSuggestionsUpdate | undefined {
        this.expected = false;
        return this.publish(null);
    }

    private publish(text: string | null): PromptSuggestionsUpdate | undefined {
        if (text === this.published) {
            return undefined;
        }
        this.published = text;
        return {
            sessionUpdate: "prompt_suggestions_update",
            suggestions: text === null ? [] : [{ prompt: [{ type: "text", text }] }],
        };
    }
}
