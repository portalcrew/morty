import type { HttpError } from "../http-error.ts";
export type ComputerAuthenticationErrorCode =
    | "computer_access_denied"
    | "credential_expired"
    | "credential_invalid"
    | "credential_revoked"
    | "invalid_request"
    | "relay_configuration_invalid"
    | "session_permission_denied";

export class ComputerAuthenticationError extends Error implements HttpError {
    readonly code: ComputerAuthenticationErrorCode;

    constructor(code: ComputerAuthenticationErrorCode, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ComputerAuthenticationError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: computerAuthenticationErrorStatus(this.code),
    });
}

function computerAuthenticationErrorStatus(code: ComputerAuthenticationErrorCode): number {
    switch (code) {
        case "invalid_request":
            return 400;
        case "credential_expired":
        case "credential_revoked":
        case "credential_invalid":
            return 401;
        case "computer_access_denied":
        case "session_permission_denied":
            return 403;
        case "relay_configuration_invalid":
            return 503;
        default:
            return code satisfies never;
    }
}
