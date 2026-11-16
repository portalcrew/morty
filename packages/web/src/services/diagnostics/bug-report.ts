import type { ComputerDiagnosticsResult } from "@portalcrew/morty-client/protocol";
import { captureFeedback, getClient } from "@sentry/react";
import type { browserDiagnosticsSnapshot } from "./browser-diagnostics.ts";
import type { ChatDiagnostics } from "./model-catalog.ts";
import type { NetworkDiagnostics } from "./network-diagnostics.ts";

export interface BugReport {
    readonly schemaVersion: 3;
    readonly chat: ChatDiagnostics;
    readonly id: string;
    readonly createdAt: string;
    readonly description: string;
    readonly page: string;
    readonly release: string;
    readonly browser: string;
    readonly relatedEventId: string | null;
    readonly computerId: string | null;
    readonly harness: string | null;
    readonly sessionId: string | null;
    readonly web: ReturnType<typeof browserDiagnosticsSnapshot>;
    readonly network: NetworkDiagnostics;
    readonly daemon:
        | { readonly kind: "available"; readonly diagnostics: ComputerDiagnosticsResult }
        | { readonly kind: "unavailable"; readonly code: string };
}
export interface BugReportSink {
    readonly submit: (report: BugReport, signal: AbortSignal, images: readonly File[]) => Promise<string>;
}
export class BugReportError extends Error {
    readonly code:
        | "REPORTING_UNAVAILABLE"
        | "REPORT_REJECTED"
        | "REPORT_TOO_LARGE"
        | "IMAGE_READ_FAILED"
        | "IMAGE_INVALID";
    constructor(code: BugReportError["code"], message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
    }
}

function imageExtension(bytes: Uint8Array, mediaType: string): string | null {
    const startsWith = (signature: readonly number[]) => signature.every((value, index) => bytes[index] === value);
    switch (mediaType) {
        case "image/png":
            return startsWith([137, 80, 78, 71, 13, 10, 26, 10]) ? "png" : null;
        case "image/jpeg":
            return startsWith([255, 216, 255]) ? "jpg" : null;
        case "image/gif":
            return startsWith([71, 73, 70, 56, 55, 97]) || startsWith([71, 73, 70, 56, 57, 97]) ? "gif" : null;
        case "image/webp":
            return startsWith([82, 73, 70, 70]) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
                ? "webp"
                : null;
        default:
            return null;
    }
}

function readImage(file: File, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const cleanup = () => {
            signal.removeEventListener("abort", abort);
            reader.onload = null;
            reader.onerror = null;
        };
        const abort = () => {
            cleanup();
            reader.abort();
            reject(signal.reason);
        };
        reader.onload = () => {
            cleanup();
            if (reader.result instanceof ArrayBuffer) {
                resolve(new Uint8Array(reader.result));
            } else {
                reject(new BugReportError("IMAGE_READ_FAILED", "An image could not be read. Remove it and try again."));
            }
        };
        reader.onerror = () => {
            cleanup();
            reject(
                new BugReportError("IMAGE_READ_FAILED", "An image could not be read. Remove it and try again.", {
                    cause: reader.error,
                }),
            );
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
            reader.readAsArrayBuffer(file);
        } catch (cause) {
            cleanup();
            reject(
                new BugReportError("IMAGE_READ_FAILED", "An image could not be read. Remove it and try again.", {
                    cause,
                }),
            );
        }
    });
}

export const sentryBugReportSink: BugReportSink = {
    submit: async (report, parent, images) => {
        const client = getClient();
        if (client === undefined || client.getDsn() === undefined) {
            throw new BugReportError(
                "REPORTING_UNAVAILABLE",
                "Bug reporting is not configured. Please try again later.",
            );
        }
        const data = JSON.stringify(report);
        if (new TextEncoder().encode(data).byteLength > 350_000) {
            throw new BugReportError("REPORT_TOO_LARGE", "Diagnostics exceeded the report limit.");
        }
        if (images.length > 3 || images.some((file) => file.size === 0 || file.size > 2_500_000)) {
            throw new BugReportError("IMAGE_INVALID", "Attach up to 3 images, each between 1 byte and 2.5 MB.");
        }
        const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
        signal.throwIfAborted();
        const attachments = [
            { filename: "diagnostics.json", contentType: "application/json", data: new TextEncoder().encode(data) },
        ];
        for (const [index, file] of images.entries()) {
            const bytes = await readImage(file, signal);
            const extension = imageExtension(bytes, file.type);
            if (extension === null) {
                throw new BugReportError(
                    "IMAGE_INVALID",
                    "An image's content does not match its format. Remove it and try again.",
                );
            }
            attachments.push({
                filename: `image-${index + 1}.${extension}`,
                contentType: file.type,
                data: bytes,
            });
        }
        signal.throwIfAborted();
        return await new Promise<string>((resolve, reject) => {
            const release = client.on("afterSendEvent", (event, response) => {
                if (event.event_id !== report.id) {
                    return;
                }
                cleanup();
                if (response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(report.id);
                } else {
                    reject(new BugReportError("REPORT_REJECTED", "The report was not accepted. Please try again."));
                }
            });
            const abort = () => {
                cleanup();
                reject(signal.reason);
            };
            const cleanup = () => {
                release();
                signal.removeEventListener("abort", abort);
            };
            signal.addEventListener("abort", abort, { once: true });
            try {
                captureFeedback(
                    {
                        message: report.description,
                        source: "morty",
                        tags: { reportId: report.id },
                        ...(report.relatedEventId === null ? {} : { associatedEventId: report.relatedEventId }),
                    },
                    {
                        event_id: report.id,
                        includeReplay: false,
                        attachments,
                    },
                );
            } catch (cause) {
                cleanup();
                reject(
                    new BugReportError("REPORT_REJECTED", "The report could not be sent. Please try again.", { cause }),
                );
            }
        });
    },
};
