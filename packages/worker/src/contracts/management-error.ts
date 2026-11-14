import type { HttpError } from "./http-error.ts";

export class ManagementError extends Error implements HttpError {
    readonly code: string;
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    /** A finer machine-readable cause that keeps `code` unchanged for readers that only know the code. */
    readonly reason: string | null;
    constructor(
        code: string,
        message: string,
        status: number,
        headers: Readonly<Record<string, string>> = {},
        options?: ErrorOptions & { readonly reason?: string },
    ) {
        super(message, options);
        this.code = code;
        this.status = status;
        this.headers = headers;
        this.reason = options?.reason ?? null;
        this.name = "ManagementError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: {
            error: {
                code: this.code,
                message: this.message,
                ...(this.reason === null ? {} : { reason: this.reason }),
            },
        },
        status: this.status,
        headers: this.headers,
    });
}

/** The answer for a computer that was never created, which every boundary gives the same way. */
export const computerNotFound = (): ManagementError =>
    new ManagementError("COMPUTER_NOT_FOUND", "The Morty computer does not exist.", 404);
