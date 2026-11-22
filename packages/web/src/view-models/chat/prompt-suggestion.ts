import type { SessionPromptSuggestions } from "@portalcrew/morty-client/protocol";

/** The most likely suggestion a draft can hold: one whose prompt is text alone. */
export function draftPromptSuggestion(suggestions: SessionPromptSuggestions["suggestions"]): string | null {
    for (const suggestion of suggestions) {
        const text = suggestion.prompt.every((block) => block.type === "text")
            ? suggestion.prompt.map((block) => (block.type === "text" ? block.text : "")).join("")
            : "";
        if (text.trim().length > 0) {
            return text;
        }
    }
    return null;
}
