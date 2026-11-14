import type { HttpError } from "../http-error.ts";

/**
 * The Computer answered a command with something the Worker cannot accept. The command may have run, so this is neither
 * the caller's invalid request nor a refusal.
 */
export const COMPUTER_REPLY_INVALID_CODE = "computer_reply_invalid";

function sessionRuntimeErrorStatus(code: string): number {
    if (code === "session_busy") {
        return 409;
    }
    if (code === COMPUTER_REPLY_INVALID_CODE) {
        return 502;
    }
    if (code === "invalid_request") {
        return 400;
    }
    return 503;
}

export class SessionRuntimeError extends Error implements HttpError {
    readonly code: string;
    readonly httpStatus: number;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.httpStatus = sessionRuntimeErrorStatus(code);
        this.name = "SessionRuntimeError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.httpStatus,
    });
}
