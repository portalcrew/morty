export interface ComputerReplyConnection {
    readonly readyState: number;
    readonly accept: () => void;
    readonly send: (message: string | ArrayBuffer | ArrayBufferView) => void;
    readonly close: (code?: number, reason?: string) => void;
    readonly addEventListener: EventTarget["addEventListener"];
    readonly removeEventListener: EventTarget["removeEventListener"];
}

export type ReplyDecision<T> = { readonly kind: "ignore" } | { readonly kind: "complete"; readonly value: T };
