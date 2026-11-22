import {
    FILE_FAILED_KIND,
    type FileReadCommand,
    fileBeginEventCodec,
    fileEndEventCodec,
    fileFailedEventCodec,
} from "@portalcrew/morty-client/protocol";
import { WebSocket } from "undici";
import { SessionError } from "../../../../session/api/session-error.ts";
import { streamLocalFile } from "../../../../session/content/session-files.ts";
import type { CommandContext } from "../../context.ts";
import { send, sendContentChunk } from "../../transport.ts";

type CreditState =
    | { readonly kind: "empty" }
    | { readonly kind: "available" }
    | { readonly kind: "waiting"; readonly resolve: () => void; readonly reject: (cause: unknown) => void }
    | { readonly kind: "closed" };

export function createFileReadCommands(context: CommandContext) {
    const reads = new Map<
        string,
        { readonly controller: AbortController; readonly credit: () => void; readonly completion: Promise<void> }
    >();
    const read = (message: FileReadCommand): Promise<void> => {
        if (reads.has(message.requestId)) {
            throw new SessionError("session_busy", "A file request with this address is already active");
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([context.signal, controller.signal]);
        const timer = context.timer.schedule(
            () => controller.abort(new DOMException("File request timed out", "TimeoutError")),
            120_000,
        );
        let credit: CreditState = { kind: "empty" };
        const grant = (): void => {
            if (credit.kind === "waiting") {
                const waiting = credit;
                credit = { kind: "empty" };
                waiting.resolve();
            } else if (credit.kind === "empty") {
                credit = { kind: "available" };
            } else if (credit.kind === "available") {
                controller.abort(new SessionError("invalid_request", "The file request received duplicate credit"));
            }
        };
        const takeCredit = async (creditSignal: AbortSignal): Promise<void> => {
            creditSignal.throwIfAborted();
            if (credit.kind === "available") {
                credit = { kind: "empty" };
                return;
            }
            if (credit.kind !== "empty") {
                throw new SessionError("invalid_request", "The file request cannot wait for credit");
            }
            await new Promise<void>((resolve, reject) => {
                const abort = () => {
                    credit = { kind: "closed" };
                    reject(creditSignal.reason);
                };
                credit = {
                    kind: "waiting",
                    resolve: () => {
                        creditSignal.removeEventListener("abort", abort);
                        resolve();
                    },
                    reject: (cause) => {
                        creditSignal.removeEventListener("abort", abort);
                        reject(cause);
                    },
                };
                creditSignal.addEventListener("abort", abort, { once: true });
                if (creditSignal.aborted) {
                    abort();
                }
            });
        };
        const completion = Promise.resolve().then(async () => {
            const { externalContent, sessions, socket, payloadEncryption, config } = context;
            try {
                const served = await streamLocalFile({
                    command: message,
                    sendBegin: async (response) =>
                        send(socket, await fileBeginEventCodec.encode(response, payloadEncryption, signal)),
                    sendEnd: async (response) =>
                        send(socket, await fileEndEventCodec.encode(response, payloadEncryption, signal)),
                    sendChunk: async (requestId, sequence, bytes) =>
                        await sendContentChunk(context, requestId, sequence, bytes, signal),
                    takeCredit,
                    signal,
                    workingDirectory: sessions.findSessions([message.target])[0]?.cwd ?? null,
                    externalContent,
                    stateDirectory: config.localContext.stateDirectory,
                });
                // A local file left the Computer: record which Session read how much, never the path itself.
                context.diagnostics.daemonDiagnostic("file_read_served", message.requestId, {
                    harness: message.target.harness,
                    sessionId: message.target.sessionId,
                    byteLength: served.byteLength.toString(),
                });
            } catch (error) {
                if (signal.aborted || socket.readyState !== WebSocket.OPEN) {
                    return;
                }
                // Only the size limit is told apart; any other failure stays opaque to the client.
                const tooLarge = error instanceof SessionError && error.code === "file_too_large";
                const code = tooLarge ? "file_too_large" : "file_unavailable";
                context.diagnostics.daemonDiagnostic("file_read_failed", message.requestId, { code }, error);
                const encoded = await fileFailedEventCodec.encode(
                    {
                        kind: FILE_FAILED_KIND,
                        code,
                        message: tooLarge ? "The local file is too large to read" : "The local file is unavailable",
                        requestId: message.requestId,
                        target: message.target,
                    },
                    payloadEncryption,
                    signal,
                );
                if (socket.readyState === WebSocket.OPEN) {
                    send(socket, encoded);
                }
            } finally {
                timer.cancel();
                if (credit.kind === "waiting") {
                    credit.reject(new DOMException("File request finished", "AbortError"));
                }
                credit = { kind: "closed" };
                reads.delete(message.requestId);
            }
        });
        reads.set(message.requestId, { controller, credit: grant, completion });
        return completion;
    };
    return {
        read,
        credit: (requestId: string): void => reads.get(requestId)?.credit(),
        cancel: (requestId: string): void =>
            reads.get(requestId)?.controller.abort(new DOMException("File request cancelled", "AbortError")),
        settle: async (): Promise<void> => {
            await Promise.allSettled([...reads.values()].map((entry) => entry.completion));
        },
    };
}
