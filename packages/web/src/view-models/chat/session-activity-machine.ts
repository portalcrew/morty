export type SessionActivityState =
    | { readonly kind: "idle" }
    | { readonly kind: "working"; readonly commandId: string }
    | { readonly kind: "failed"; readonly commandId: string; readonly code: string; readonly message: string };
