import { MAX_PROMPT_ATTACHMENT_BYTES, PROMPT_IMAGE_MAX_BYTES } from "@portalcrew/morty-client/protocol";
import type { ComposerAttachment } from "../../components/chat/composer-attachment.ts";

const READ_TIMEOUT_MILLISECONDS = 15_000;

export class AttachmentReadError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "AttachmentReadError";
    }
}

function readBytes(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const timeout = window.setTimeout(() => {
            // Aborting the reader dispatches its abort event at once, which would report the read as cancelled.
            cleanup();
            reject(new AttachmentReadError("attachment_timeout", `Timed out while reading ${file.name}.`));
            reader.abort();
        }, READ_TIMEOUT_MILLISECONDS);
        const cleanup = (): void => {
            signal.removeEventListener("abort", cancel);
            window.clearTimeout(timeout);
            reader.removeEventListener("abort", handleAbort);
            reader.removeEventListener("error", handleError);
            reader.removeEventListener("load", handleLoad);
        };
        const handleAbort = (): void => {
            cleanup();
            reject(
                signal.aborted
                    ? signal.reason
                    : new AttachmentReadError("attachment_cancelled", `Reading ${file.name} was cancelled.`),
            );
        };
        const handleError = (): void => {
            cleanup();
            reject(
                new AttachmentReadError("attachment_read_failed", `Could not read ${file.name}.`, {
                    cause: reader.error,
                }),
            );
        };
        const handleLoad = (): void => {
            const result = reader.result;
            cleanup();
            if (!(result instanceof ArrayBuffer)) {
                reject(
                    new AttachmentReadError("attachment_read_failed", `${file.name} did not contain readable bytes.`),
                );
                return;
            }
            resolve(result);
        };
        const cancel = (): void => reader.abort();
        signal.addEventListener("abort", cancel, { once: true });
        reader.addEventListener("abort", handleAbort, { once: true });
        reader.addEventListener("error", handleError, { once: true });
        reader.addEventListener("load", handleLoad, { once: true });
        reader.readAsArrayBuffer(file);
    });
}

function attachmentUri(name: string): string {
    return `attachment:///${encodeURIComponent(name.replaceAll("/", "_"))}`;
}

export async function readPromptAttachment(file: File, signal: AbortSignal): Promise<ComposerAttachment> {
    signal.throwIfAborted();
    const rasterImage = /^image\/(?:gif|jpeg|png|webp)$/u.test(file.type);
    const lowerName = file.name.toLowerCase();
    const svg = file.type === "image/svg+xml" || (file.type.length === 0 && lowerName.endsWith(".svg"));
    const pdf = file.type === "application/pdf" || (file.type.length === 0 && lowerName.endsWith(".pdf"));
    const limit = rasterImage ? PROMPT_IMAGE_MAX_BYTES : MAX_PROMPT_ATTACHMENT_BYTES;
    if (file.size === 0 || file.size > limit) {
        throw new AttachmentReadError(
            "attachment_size_invalid",
            rasterImage ? "Images must be between 1 byte and 5 MB." : "Files must be between 1 byte and 32 MB.",
        );
    }
    const bytes = new Uint8Array(await readBytes(file, signal));
    signal.throwIfAborted();
    if (rasterImage) {
        return {
            bytes,
            kind: "image",
            mediaType: file.type,
            name: file.name,
            uri: attachmentUri(file.name),
        };
    }
    return {
        bytes,
        kind: "resource",
        mediaType: svg
            ? "image/svg+xml"
            : pdf
              ? "application/pdf"
              : file.type.length > 0
                ? file.type
                : "application/octet-stream",
        name: file.name,
        uri: attachmentUri(file.name),
    };
}
