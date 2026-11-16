import type { PromptCompletion } from "@portalcrew/morty-client/protocol";

export type PromptEnd =
    | { readonly kind: "ended"; readonly stopReason: string }
    | { readonly kind: "cancelled" }
    | { readonly kind: "steered" };

/** The end of a prompt the Agent stopped for `stopReason`; the ACP stop reason `cancelled` is a cancellation. */
export function promptEnd(stopReason: string): PromptEnd {
    return stopReason === "cancelled" ? { kind: "cancelled" } : { kind: "ended", stopReason };
}

export function promptCompletion(end: PromptEnd, started: boolean): PromptCompletion {
    return end.kind === "cancelled" ? { kind: "cancelled", started } : end;
}
