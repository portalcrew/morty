export class MortyError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "MortyError";
    }
}

export class MortyApiError extends MortyError {
    readonly status: number;

    constructor(code: string, message: string, status: number, options: ErrorOptions = {}) {
        super(code, message, options);
        this.name = "MortyApiError";
        this.status = status;
    }
}

/** A validated Computer reply, distinct from HTTP, malformed responses, and an attempt whose outcome is unknown. */
export class MortyOperationError extends MortyError {
    readonly recovery: "terminal" | "retryable";

    constructor(code: string, message: string, recovery: "terminal" | "retryable", options: ErrorOptions = {}) {
        super(code, message, options);
        this.name = "MortyOperationError";
        this.recovery = recovery;
    }
}

export class MortyCancellationError extends MortyError {
    constructor(options: ErrorOptions = {}) {
        super("operation_cancelled", "The Morty operation was cancelled", options);
        this.name = "MortyCancellationError";
    }
}

export class MortyConnectionError extends MortyError {
    constructor(message: string, options: ErrorOptions = {}) {
        super("service_unavailable", message, options);
        this.name = "MortyConnectionError";
    }
}

export class MortyProtocolError extends MortyError {
    constructor(message: string, options: ErrorOptions = {}) {
        super("invalid_service_response", message, options);
        this.name = "MortyProtocolError";
    }
}

export class MortyTimeoutError extends MortyError {
    constructor(options: ErrorOptions = {}) {
        super("operation_timeout", "The Morty operation timed out", options);
        this.name = "MortyTimeoutError";
    }
}

export class MortyValidationError extends MortyError {
    constructor(message: string, options: ErrorOptions = {}) {
        super("invalid_request", message, options);
        this.name = "MortyValidationError";
    }
}
