/**
 * How this device gets setup to the computer where the coding agent runs. A desktop browser is usually that
 * computer, so it copies the prompt. A touch-first phone or tablet cannot run the agent, so it sends Morty's
 * address on: through the system share sheet when the browser has one, otherwise by copying the link.
 */
export type SetupHandoff =
    | { readonly kind: "copy-prompt" }
    | { readonly kind: "send-link"; readonly share: ((data: ShareData) => Promise<void>) | null };

/** Touch-first by capability, not by user agent: a tablet with a trackpad keeps the desktop flow. */
const touchFirstQuery = "(hover: none) and (pointer: coarse)";

/** The instruction a person pastes into the agent on the computer that should run setup. */
export function agentSetupPrompt(): string {
    return `Fetch ${window.location.origin}/doc/setup.md and complete the Morty setup for me. You may install missing prerequisites and pair this computer.`;
}

export function browserSetupHandoff(): SetupHandoff {
    if (!window.matchMedia(touchFirstQuery).matches) {
        return { kind: "copy-prompt" };
    }
    return {
        kind: "send-link",
        share: typeof navigator.share === "function" ? (data) => navigator.share(data) : null,
    };
}
