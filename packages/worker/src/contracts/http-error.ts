export interface HttpErrorJson {
    readonly body: {
        readonly error: { readonly code: string; readonly message: string; readonly reason?: string };
    };
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpError extends Error {
    readonly toHttpJson: () => HttpErrorJson;
}

export function isHttpError(error: unknown): error is HttpError {
    return error instanceof Error && "toHttpJson" in error && typeof error.toHttpJson === "function";
}

// Every deadline aborts with the platform's TimeoutError, so this is the one place a timeout gets its wire code.
export function toHttpError(error: unknown): HttpErrorJson {
    if (isHttpError(error)) {
        return error.toHttpJson();
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
        return {
            body: { error: { code: "operation_timeout", message: "The Morty operation timed out" } },
            status: 504,
            headers: {},
        };
    }
    return {
        body: { error: { code: "internal_error", message: "The request could not be completed" } },
        status: 500,
        headers: {},
    };
}
