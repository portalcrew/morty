import {
    CONTENT_UPLOAD_MAX_ENCODED_BYTES,
    decodeFileStreamRecord,
    type FileStreamRecord,
} from "@morty-build/client/protocol";
import { SessionRuntimeError } from "../../../../contracts/relay/session.ts";

/** Owns the bounded HTTP record buffer and cancellation of its underlying reader. */
export class ContentUploadReader {
    readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
    #buffer = new Uint8Array(0);
    #receivedBytes = 0;

    constructor(body: ReadableStream<Uint8Array>) {
        this.#reader = body.getReader();
    }

    readonly read = async (signal: AbortSignal): Promise<FileStreamRecord | null> => {
        const abort = () => {
            void this.#reader.cancel(signal.reason).catch(() => undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            while (true) {
                signal.throwIfAborted();
                const decoded = decodeFileStreamRecord(this.#buffer);
                if (decoded.kind === "record") {
                    this.#buffer = this.#buffer.slice(decoded.byteLength);
                    return decoded.record;
                }
                const next = await this.#reader.read();
                signal.throwIfAborted();
                if (next.done) {
                    if (this.#buffer.byteLength !== 0) {
                        throw new SessionRuntimeError("invalid_request", "The content record is incomplete");
                    }
                    return null;
                }
                this.#receivedBytes += next.value.byteLength;
                if (this.#receivedBytes > CONTENT_UPLOAD_MAX_ENCODED_BYTES) {
                    throw new SessionRuntimeError("invalid_request", "The encrypted content exceeds its size limit");
                }
                const buffer = new Uint8Array(this.#buffer.byteLength + next.value.byteLength);
                buffer.set(this.#buffer);
                buffer.set(next.value, this.#buffer.byteLength);
                this.#buffer = buffer;
            }
        } finally {
            signal.removeEventListener("abort", abort);
        }
    };

    readonly close = async (): Promise<void> => {
        try {
            await this.#reader.cancel();
        } finally {
            this.#reader.releaseLock();
        }
    };
}
