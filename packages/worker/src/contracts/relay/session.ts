import type { HttpError } from "../http-error.ts";

function sessionRuntimeErrorStatus(code: string): number {
    if (code === "session_busy") {
        return 409;
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
