import { SESSION_CLOSED_ERROR_CODE, type SessionOperationFailedEvent } from "@morty-build/client/protocol";
import type { HttpError } from "../http-error.ts";

function sessionRuntimeErrorStatus(code: string): number {
    if (code === "session_not_found") {
        return 404;
    }
    if (
        code === "session_busy" ||
        code === SESSION_CLOSED_ERROR_CODE ||
        code === "idempotency_conflict" ||
        // An operation the Computer started but cannot tell the end of: repeating it cannot answer differently.
        code === "session_creation_outcome_unknown" ||
        code === "command_result_expired" ||
        code === "turn_already_started" ||
        code === "permission_response_conflict" ||
        code === "session_configuration_conflict" ||
        code === "steering_target_unavailable" ||
        code === "steering_unsupported"
    ) {
        return 409;
    }
    if (code === "invalid_request") {
        return 400;
    }
    if (code === "unsupported_operation") {
        return 501;
    }
    return 503;
}

interface SessionRuntimeErrorOptions extends ErrorOptions {
    readonly runtimeTimings?: NonNullable<SessionOperationFailedEvent["runtimeTimings"]> | undefined;
}

export class SessionRuntimeError extends Error implements HttpError {
    readonly code: string;
    readonly httpStatus: number;
    readonly runtimeTimings: NonNullable<SessionOperationFailedEvent["runtimeTimings"]>;

    constructor(code: string, message: string, options: SessionRuntimeErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.httpStatus = sessionRuntimeErrorStatus(code);
        this.name = "SessionRuntimeError";
        this.runtimeTimings = options.runtimeTimings ?? [];
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.httpStatus,
    });
}
