import { CONTENT_UPLOAD_MAX_ENCODED_BYTES } from "@morty-build/client/protocol";
import type { HttpError } from "../../../../contracts/http-error.ts";

const MAX_PENDING_BYTES = CONTENT_UPLOAD_MAX_ENCODED_BYTES;
const MAX_PENDING_UPLOADS = 16;

class UploadAdmissionError extends Error implements HttpError {
    readonly #code: "invalid_message" | "request_capacity_exceeded";

    constructor(code: "invalid_message" | "request_capacity_exceeded") {
        super(
            code === "invalid_message"
                ? "The WebSocket transport message is invalid"
                : "The WebSocket transport has too many pending uploads",
        );
        this.name = "UploadAdmissionError";
        this.#code = code;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.#code, message: this.message } },
        status: this.#code === "invalid_message" ? 400 : 429,
    });
}

/** One Computer application's authorized uploads share capacity across all WebSocket connections. */
export class WebSocketUploadCapacity {
    #bytes = 0;
    #uploads = 0;

    readonly reserve = (byteLength: number, signal: AbortSignal): void => {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_PENDING_BYTES) {
            throw new UploadAdmissionError("invalid_message");
        }
        if (this.#bytes + byteLength > MAX_PENDING_BYTES || this.#uploads >= MAX_PENDING_UPLOADS) {
            throw new UploadAdmissionError("request_capacity_exceeded");
        }
        this.#bytes += byteLength;
        this.#uploads += 1;
        signal.addEventListener(
            "abort",
            () => {
                this.#bytes -= byteLength;
                this.#uploads -= 1;
            },
            { once: true },
        );
    };
}
