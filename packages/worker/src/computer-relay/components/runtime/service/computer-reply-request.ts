/** The Relay refused this request itself; the Computer was never asked, or can no longer answer. */
export class RequestRejectedEvent extends Event {
    readonly requestId: string;
    readonly code: string;
    readonly message: string;

    constructor(requestId: string, code: string, message: string) {
        super("rejected");
        this.requestId = requestId;
        this.code = code;
        this.message = message;
    }
}

export interface ComputerReplyConnection {
    readonly readyState: number;
    readonly accept: () => void;
    readonly send: (message: string | ArrayBuffer | ArrayBufferView) => void;
    /** Asks the Computer to stop an in-flight request; a closed request has nothing to stop. */
    readonly cancel: () => void;
    /** Allows the Computer to send one more chunk of a file read. */
    readonly creditFile: () => void;
    readonly close: (code?: number, reason?: string) => void;
    readonly addEventListener: EventTarget["addEventListener"];
    readonly removeEventListener: EventTarget["removeEventListener"];
}

export type ReplyDecision<T> = { readonly kind: "ignore" } | { readonly kind: "complete"; readonly value: T };
