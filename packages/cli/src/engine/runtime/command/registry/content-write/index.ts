import { createHash } from "node:crypto";
import { sameNativeSession } from "@morty-build/client/native-session";
import {
    CONTENT_AVAILABLE_KIND,
    type CONTENT_COMMIT_KIND,
    CONTENT_READY_KIND,
    type CONTENT_WRITE_KIND,
    CONTENT_WRITE_MAX_BYTES,
    type ContentChunkFrame,
    type ContentWriteCommand,
    contentAvailableEventCodec,
    contentReadyEventCodec,
    encodeContentChunkAck,
    FILE_FAILED_KIND,
    fileFailedEventCodec,
    type NativeSessionTarget,
} from "@morty-build/client/protocol";
import type { ScheduledTask } from "../../../../util/timer.ts";
import type { CommandContext } from "../../context.ts";
import type { CommandMessage } from "../../definition.ts";
import { send } from "../../transport.ts";

interface WriteResources {
    readonly bytes: Uint8Array;
    readonly command: ContentWriteCommand;
    readonly hash: ReturnType<typeof createHash>;
    readonly controller: AbortController;
    readonly timeout: ScheduledTask;
}

type PendingWrite =
    | (WriteResources & { readonly kind: "receiving"; readonly receivedBytes: number; readonly sequence: number })
    | (WriteResources & { readonly kind: "committing" });

const MAX_PENDING_UPLOAD_BYTES = 2 * CONTENT_WRITE_MAX_BYTES;
const MAX_PENDING_UPLOADS = 16;
const UPLOAD_TIMEOUT_MILLISECONDS = 90_000;

export interface ContentWriteCommands {
    readonly write: (message: CommandMessage<typeof CONTENT_WRITE_KIND>) => Promise<void>;
    readonly commit: (message: CommandMessage<typeof CONTENT_COMMIT_KIND>) => void | Promise<void>;
    readonly receiveChunk: (frame: ContentChunkFrame) => Promise<void>;
    readonly rejectCapacity: (requestId: string, target: NativeSessionTarget | undefined) => Promise<boolean>;
    readonly cancel: (requestId: string) => void;
    readonly settle: () => Promise<void>;
}

export function createContentWriteCommands(context: CommandContext): ContentWriteCommands {
    const pending = new Map<string, PendingWrite>();
    const operations = new Set<Promise<void>>();
    let reservedBytes = 0;

    const release = (state: PendingWrite): void => {
        if (pending.get(state.command.requestId)?.controller !== state.controller) {
            return;
        }
        pending.delete(state.command.requestId);
        state.timeout.cancel();
        reservedBytes -= state.bytes.byteLength;
    };

    const cancel = (requestId: string): void => {
        const state = pending.get(requestId);
        if (state === undefined) {
            return;
        }
        state.controller.abort(new DOMException("Content upload cancelled", "AbortError"));
        if (state.kind === "receiving") {
            release(state);
        }
    };

    const cancelAll = (): void => {
        for (const requestId of pending.keys()) {
            cancel(requestId);
        }
    };
    context.signal.addEventListener("abort", cancelAll, { once: true });

    const replyFailure = async (
        command: Pick<ContentWriteCommand, "requestId" | "target">,
        code: string,
        message: string,
    ): Promise<void> => {
        send(
            context.socket,
            await fileFailedEventCodec.encode(
                {
                    code,
                    kind: FILE_FAILED_KIND,
                    message,
                    requestId: command.requestId,
                    target: command.target,
                },
                context.payloadEncryption,
                context.signal,
            ),
        );
    };

    const fail = async (command: Pick<ContentWriteCommand, "requestId" | "target">, error: unknown): Promise<void> => {
        const state = pending.get(command.requestId);
        if (state !== undefined && sameNativeSession(state.command.target, command.target)) {
            state.controller.abort(new DOMException("Content upload failed", "AbortError"));
            if (state.kind === "receiving") {
                release(state);
            }
        }
        await replyFailure(
            command,
            "content_write_failed",
            error instanceof Error ? error.message : "The content could not be stored",
        );
    };

    const rejectCapacity = async (requestId: string, target: NativeSessionTarget | undefined): Promise<boolean> => {
        const write = pending.get(requestId);
        if (write === undefined || (target !== undefined && !sameNativeSession(write.command.target, target))) {
            return false;
        }
        write.controller.abort(new DOMException("Content upload capacity exhausted", "AbortError"));
        if (write.kind === "receiving") {
            release(write);
        }
        send(
            context.socket,
            await fileFailedEventCodec.encode(
                {
                    kind: FILE_FAILED_KIND,
                    requestId,
                    target: write.command.target,
                    code: "e2e_store_busy",
                    message: "The Computer encryption store is busy",
                },
                context.payloadEncryption,
                context.signal,
            ),
        );
        return true;
    };

    const write = async (message: CommandMessage<typeof CONTENT_WRITE_KIND>): Promise<void> => {
        const existing = pending.get(message.requestId);
        if (existing !== undefined) {
            if (existing.kind !== "receiving") {
                await replyFailure(message, "content_write_busy", "The content upload is being committed");
                return;
            }
            if (JSON.stringify(existing.command) !== JSON.stringify(message)) {
                await fail(message, new Error("The content request identifier is already in use"));
                return;
            }
        } else {
            context.signal.throwIfAborted();
            if (pending.size >= MAX_PENDING_UPLOADS || reservedBytes + message.byteLength > MAX_PENDING_UPLOAD_BYTES) {
                await replyFailure(message, "content_write_busy", "The Computer has too many pending content uploads");
                return;
            }
            const bytes = new Uint8Array(message.byteLength);
            const controller = new AbortController();
            const timeout = context.timer.schedule(() => {
                const state = pending.get(message.requestId);
                if (state === undefined || state.controller !== controller) {
                    return;
                }
                cancel(message.requestId);
                if (!context.signal.aborted) {
                    void replyFailure(message, "content_write_timeout", "The content upload timed out").catch(
                        (error: unknown) => {
                            context.diagnostics.daemonDiagnostic(
                                "content_upload_timeout_reply_failed",
                                message.requestId,
                                {},
                                error,
                            );
                        },
                    );
                }
            }, UPLOAD_TIMEOUT_MILLISECONDS);
            pending.set(message.requestId, {
                kind: "receiving",
                bytes,
                command: message,
                hash: createHash("sha256"),
                controller,
                timeout,
                receivedBytes: 0,
                sequence: 0,
            });
            reservedBytes += bytes.byteLength;
        }
        const state = pending.get(message.requestId);
        if (state === undefined) {
            return;
        }
        const signal = AbortSignal.any([context.signal, state.controller.signal]);
        try {
            const encoded = await contentReadyEventCodec.encode(
                {
                    kind: CONTENT_READY_KIND,
                    requestId: message.requestId,
                    target: message.target,
                },
                context.payloadEncryption,
                signal,
            );
            signal.throwIfAborted();
            send(context.socket, encoded);
        } catch (cause) {
            const state = pending.get(message.requestId);
            if (state !== undefined && sameNativeSession(state.command.target, message.target)) {
                cancel(message.requestId);
            }
            if (signal.aborted) {
                return;
            }
            throw cause;
        }
    };

    const commit = (message: CommandMessage<typeof CONTENT_COMMIT_KIND>): void | Promise<void> => {
        const state = pending.get(message.requestId);
        if (state?.kind === "committing") {
            return replyFailure(message, "content_write_busy", "The content upload is being committed");
        }
        if (state === undefined || !sameNativeSession(state.command.target, message.target)) {
            return fail(message, new Error("The content upload is unavailable"));
        }
        const committing: PendingWrite = {
            kind: "committing",
            bytes: state.bytes,
            command: state.command,
            hash: state.hash,
            controller: state.controller,
            timeout: state.timeout,
        };
        pending.set(message.requestId, committing);
        const signal = AbortSignal.any([context.signal, state.controller.signal]);
        const operation = (async () => {
            try {
                signal.throwIfAborted();
                if (state.receivedBytes !== state.command.byteLength) {
                    throw new Error("The content upload ended at an unexpected length");
                }
                if (state.hash.digest("hex") !== state.command.contentKey) {
                    throw new Error("The content upload failed integrity validation");
                }
                const stored = await context.externalContent.put({
                    bytes: state.bytes,
                    kind: state.command.contentKind,
                    mediaType: state.command.mediaType,
                    name: state.command.name,
                    target: state.command.target,
                    signal,
                });
                signal.throwIfAborted();
                if (stored.key !== state.command.contentKey || stored.byteLength !== state.command.byteLength) {
                    throw new Error("Stored content did not match the upload");
                }
                send(
                    context.socket,
                    await contentAvailableEventCodec.encode(
                        {
                            byteLength: stored.byteLength,
                            contentKey: stored.key,
                            kind: CONTENT_AVAILABLE_KIND,
                            requestId: message.requestId,
                            target: message.target,
                        },
                        context.payloadEncryption,
                        signal,
                    ),
                );
            } catch (error) {
                if (!signal.aborted) {
                    await fail(message, error);
                }
            } finally {
                release(committing);
            }
        })();
        operations.add(operation);
        void operation.then(
            () => operations.delete(operation),
            () => operations.delete(operation),
        );
        return operation;
    };

    return {
        write,
        commit,
        rejectCapacity,
        cancel,
        receiveChunk: async (frame) => {
            const state = pending.get(frame.requestId);
            if (state === undefined || state.kind !== "receiving") {
                context.diagnostics.daemonDiagnostic("content_chunk_discarded", frame.requestId, {
                    reason: "upload_unavailable",
                    sequence: frame.sequence.toString(),
                });
                return;
            }
            if (
                frame.sequence !== state.sequence ||
                state.receivedBytes + frame.bytes.byteLength > state.command.byteLength
            ) {
                await fail(state.command, new Error("The content upload contains invalid chunks"));
                return;
            }
            state.bytes.set(frame.bytes, state.receivedBytes);
            state.hash.update(frame.bytes);
            pending.set(frame.requestId, {
                ...state,
                receivedBytes: state.receivedBytes + frame.bytes.byteLength,
                sequence: state.sequence + 1,
            });
            send(
                context.socket,
                encodeContentChunkAck({
                    kind: "content.chunk.ack",
                    requestId: frame.requestId,
                    sequence: frame.sequence,
                }),
            );
        },
        settle: async () => {
            context.signal.removeEventListener("abort", cancelAll);
            cancelAll();
            await Promise.allSettled([...operations]);
        },
    };
}
