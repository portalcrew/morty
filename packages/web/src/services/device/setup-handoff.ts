import { isTouchFirst } from "../../touch-first.ts";

/**
 * How this device gets setup to the computer where the agent runs. A desktop browser is usually that
 * computer, so it copies the prompt. A touch-first phone or tablet cannot run the agent, so it sends Morty's
 * address on: through the system share sheet when the browser has one, otherwise by copying the link.
 */
export type SetupHandoff =
    | { readonly kind: "copy-prompt" }
    | { readonly kind: "send-link"; readonly share: ((data: ShareData) => Promise<void>) | null };

export function agentSetupPrompt(): string {
    return `Fetch ${window.location.origin}/doc/setup.md and complete the Morty setup for me. You may install missing prerequisites and pair this computer.`;
}

export function browserSetupHandoff(): SetupHandoff {
    if (!isTouchFirst()) {
        return { kind: "copy-prompt" };
    }
    return {
        kind: "send-link",
        share: typeof navigator.share === "function" ? (data) => navigator.share(data) : null,
    };
}
