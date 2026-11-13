import type { PromptCompletion } from "@morty-build/client/protocol";

/** How a prompt's execution ended, before its receipts say whether it ever started. */
export type PromptEnd =
    | { readonly kind: "ended"; readonly stopReason: string }
    | { readonly kind: "cancelled" }
    | { readonly kind: "steered" };

/** The end of a prompt the Agent stopped for `stopReason`; the ACP stop reason `cancelled` is a cancellation. */
export function promptEnd(stopReason: string): PromptEnd {
    return stopReason === "cancelled" ? { kind: "cancelled" } : { kind: "ended", stopReason };
}

/** What the Session history records of a prompt's end: a cancellation says whether the prompt ever started. */
export function promptCompletion(end: PromptEnd, started: boolean): PromptCompletion {
    return end.kind === "cancelled" ? { kind: "cancelled", started } : end;
}
