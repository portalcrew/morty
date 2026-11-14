import {
    type AgentSettingsDiscoverCommandRouting,
    agentSettingsDiscoveredEventCodec,
    agentSettingsDiscoveryFailedEventCodec,
    CONTENT_AVAILABLE_KIND,
    CONTENT_CHUNK_ACK_KIND,
    CONTENT_CHUNK_MAX_BYTES,
    CONTENT_READY_KIND,
    CONTENT_WRITE_MAX_BYTES,
    contentAvailableEventCodec,
    contentChunkCodec,
    contentCommitCommandCodec,
    contentReadyEventCodec,
    type contentWriteCommandCodec,
    decodeContentChunkAck,
    decodeMessageKind,
    encodeClientToRelayMessage,
    encodeFileStreamRecord,
    FILE_BEGIN_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    FILE_STREAM_CONTENT_TYPE,
    FILE_STREAM_MAX_CHUNK_BYTES,
    type FileReadCommandRouting,
    fileBeginEventCodec,
    fileEndEventCodec,
    fileFailedEventCodec,
    type NativeSessionTarget,
} from "@morty-build/client/protocol";
import { COMPUTER_REPLY_INVALID_CODE, SessionRuntimeError } from "../../../../contracts/relay/session.ts";
import { logger } from "../../../../infra/logger.ts";
import {
    type ClientControlCommand,
    type ClientControlReply,
    computerControlRegistry,
    computerControlReplyDecoders,
    computerControlTarget,
} from "./computer-control-registry.ts";
import { type ComputerReplyConnection, type ReplyDecision, RequestRejectedEvent } from "./computer-reply-request.ts";
import type { ContentUploadReader } from "./content-upload-reader.ts";

/** A reply the Worker cannot accept: the Computer, not the caller, is at fault, and the command may have run. */
function invalidComputerReply(message: string, options: ErrorOptions = {}): SessionRuntimeError {
    return new SessionRuntimeError(COMPUTER_REPLY_INVALID_CODE, message, options);
}

export interface ComputerFileStream {
    readonly finished: Promise<void>;
    readonly response: Response;
}

/** The caller owns request semantics; this exchange owns its single reply and cleanup. */
interface ComputerExchange<Reply> {
    readonly send: () => void;
    readonly receive: (
        data: string,
        kind: string,
        fail: (cause: unknown) => void,
        deadline: AbortSignal,
    ) => ReplyDecision<Reply>;
    readonly abandoned?: () => void;
    readonly settled?: () => Promise<void>;
}

async function awaitComputerReply<Reply>(
    socket: ComputerReplyConnection,
    signal: AbortSignal,
    exchange: ComputerExchange<Reply>,
): Promise<Reply> {
    const timeout = new AbortController();
    const stopped = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Computer request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal, stopped.signal]);
    let cleanup = () => {};
    let completed = false;
    try {
        const result = await new Promise<Reply>((resolve, reject) => {
            const onClose = () => reject(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
            const onAbort = () => {
                reject(deadline.reason);
            };
            const onMessage = (event: Event) => {
                if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
                    return;
                }
                try {
                    const result = exchange.receive(event.data, decodeMessageKind(event.data), reject, deadline);
                    if (result.kind === "complete") {
                        resolve(result.value);
                    }
                } catch (cause) {
                    if (deadline.aborted) {
                        reject(deadline.reason);
                        return;
                    }
                    reject(
                        cause instanceof SessionRuntimeError
                            ? cause
                            : invalidComputerReply("The Computer returned an invalid response", { cause }),
                    );
                }
            };
            const onRejected = (event: Event) => {
                if (event instanceof RequestRejectedEvent) {
                    reject(new SessionRuntimeError(event.code, event.message));
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("rejected", onRejected);
                socket.removeEventListener("offline", onClose);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("rejected", onRejected);
            socket.addEventListener("offline", onClose);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            try {
                deadline.throwIfAborted();
                exchange.send();
            } catch (cause) {
                reject(cause);
            }
        });
        completed = true;
        return result;
    } finally {
        if (!completed) {
            try {
                exchange.abandoned?.();
            } catch {
                // The original failure remains authoritative if cleanup cannot reach the Computer.
            }
        }
        cleanup();
        stopped.abort();
        clearTimeout(timer);
        try {
            await exchange.settled?.().catch(() => undefined);
        } finally {
            socket.close(1000, "Operation finished");
        }
    }
}

/** Waits for an addressed reply without interpreting either endpoint's private data. */
export async function requestClientControl(
    socket: ComputerReplyConnection,
    command: ClientControlCommand,
    signal: AbortSignal,
    callerCancellation?: AbortSignal,
): Promise<ClientControlReply> {
    const encoded = encodeClientToRelayMessage(command);
    const requestId = command.requestId;
    const target = computerControlTarget(command);
    const successKind = computerControlRegistry[command.kind];
    const accept = (reply: ClientControlReply): ReplyDecision<ClientControlReply> => {
        if (reply.requestId !== requestId) {
            return { kind: "ignore" };
        }
        if (
            target !== undefined &&
            "target" in reply &&
            reply.target !== undefined &&
            (reply.kind !== "native.session.result" || reply.action !== "fork") &&
            (reply.target.harness !== target.harness || reply.target.sessionId !== target.sessionId)
        ) {
            throw invalidComputerReply("The Computer returned an invalid reply target");
        }
        if (
            command.kind === "native.session.request" &&
            reply.kind === "native.session.result" &&
            reply.action !== command.action
        ) {
            throw invalidComputerReply("The Computer returned an invalid native operation");
        }
        if (
            command.kind === "agent.settings.discover" &&
            reply.kind === "agent.settings.discovered" &&
            reply.harness !== command.harness
        ) {
            throw invalidComputerReply("The Computer returned an invalid Agent settings target");
        }
        return { kind: "complete", value: reply };
    };
    const failureKind =
        command.kind === "agent.settings.discover" ? "agent.settings.discovery.failed" : "session.operation.failed";
    const handlers: Readonly<Record<string, ((message: string) => ReplyDecision<ClientControlReply>) | undefined>> = {
        [successKind]: (message) => accept(computerControlReplyDecoders[successKind](message)),
        [failureKind]: (message) => accept(computerControlReplyDecoders[failureKind](message)),
    };
    const cancel = (): void => {
        if (command.kind === "native.session.request") {
            socket.cancel();
        }
    };
    callerCancellation?.addEventListener("abort", cancel, { once: true });
    try {
        return await awaitComputerReply(socket, signal, {
            send: () => {
                callerCancellation?.throwIfAborted();
                socket.send(encoded);
            },
            receive: (message, kind) => handlers[kind]?.(message) ?? { kind: "ignore" },
            abandoned: () => {
                if (command.kind === "native.session.request" && command.action === "fork") {
                    socket.close(1011, "Fork reply was not drained");
                } else {
                    cancel();
                }
            },
        });
    } finally {
        callerCancellation?.removeEventListener("abort", cancel);
    }
}

export async function requestComputerContentWrite(
    socket: ComputerReplyConnection,
    encodedCommand: string,
    command: ReturnType<typeof contentWriteCommandCodec.decodeRouting>,
    records: ContentUploadReader,
    signal: AbortSignal,
): Promise<string> {
    type UploadState = { readonly kind: "waiting" } | { readonly kind: "uploading" } | { readonly kind: "committed" };
    let state: UploadState = { kind: "waiting" };
    let upload: Promise<void> = Promise.resolve();
    let acknowledgement: { readonly sequence: number; readonly resolve: () => void } | null = null;
    const waitForAck = (sequence: number, deadline: AbortSignal): Promise<void> =>
        new Promise((resolve, reject) => {
            const abort = () => {
                acknowledgement = null;
                reject(deadline.reason);
            };
            acknowledgement = {
                sequence,
                resolve: () => {
                    deadline.removeEventListener("abort", abort);
                    acknowledgement = null;
                    resolve();
                },
            };
            deadline.addEventListener("abort", abort, { once: true });
            if (deadline.aborted) {
                abort();
            }
        });
    const sendBody = async (deadline: AbortSignal): Promise<void> => {
        let sequence = 0;
        let sentBytes = 0;
        const maximum = Math.ceil(CONTENT_WRITE_MAX_BYTES / CONTENT_CHUNK_MAX_BYTES) * FILE_STREAM_MAX_CHUNK_BYTES;
        while (true) {
            const record = await records.read(deadline);
            deadline.throwIfAborted();
            if (record === null) {
                throw new SessionRuntimeError("invalid_request", "The content commit is required");
            }
            if (record.kind === "chunk") {
                const chunk = contentChunkCodec.decodeRouting(record.encoded);
                sentBytes += record.encoded.byteLength;
                if (chunk.requestId !== command.requestId || chunk.sequence !== sequence || sentBytes > maximum) {
                    throw new SessionRuntimeError("invalid_request", "The encrypted content chunks are invalid");
                }
                const accepted = waitForAck(sequence, deadline);
                try {
                    socket.send(record.encoded);
                } catch (cause) {
                    void accepted.catch(() => undefined);
                    throw cause;
                }
                await accepted;
                sequence += 1;
                continue;
            }
            const commit = contentCommitCommandCodec.decodeRouting(record.encoded);
            if (
                commit.requestId !== command.requestId ||
                commit.target.harness !== command.target.harness ||
                commit.target.sessionId !== command.target.sessionId ||
                sequence === 0 ||
                (await records.read(deadline)) !== null
            ) {
                throw new SessionRuntimeError("invalid_request", "The content commit is invalid");
            }
            deadline.throwIfAborted();
            state = { kind: "committed" };
            socket.send(record.encoded);
            return;
        }
    };
    const matches = (reply: { readonly requestId: string; readonly target: NativeSessionTarget }): boolean => {
        if (reply.requestId !== command.requestId) {
            return false;
        }
        if (reply.target.harness !== command.target.harness || reply.target.sessionId !== command.target.sessionId) {
            throw invalidComputerReply("The Computer returned an invalid content target");
        }
        return true;
    };
    return await awaitComputerReply(socket, signal, {
        send: () => socket.send(encodedCommand),
        abandoned: () => socket.cancel(),
        receive: (encoded, kind, fail, deadline) => {
            switch (kind) {
                case CONTENT_CHUNK_ACK_KIND: {
                    const ack = decodeContentChunkAck(encoded);
                    if (
                        ack.requestId !== command.requestId ||
                        acknowledgement === null ||
                        ack.sequence !== acknowledgement.sequence
                    ) {
                        throw invalidComputerReply("The Computer returned an invalid content acknowledgement");
                    }
                    acknowledgement.resolve();
                    return { kind: "ignore" };
                }
                case CONTENT_READY_KIND:
                    if (!matches(contentReadyEventCodec.decodeRouting(encoded))) {
                        return { kind: "ignore" };
                    }
                    if (state.kind !== "waiting") {
                        throw invalidComputerReply("The Computer repeated content admission");
                    }
                    state = { kind: "uploading" };
                    upload = Promise.resolve()
                        .then(() => sendBody(deadline))
                        .catch(fail);
                    return { kind: "ignore" };
                case CONTENT_AVAILABLE_KIND:
                    if (!matches(contentAvailableEventCodec.decodeRouting(encoded))) {
                        return { kind: "ignore" };
                    }
                    if (state.kind !== "committed") {
                        throw invalidComputerReply("The Computer completed an uncommitted upload");
                    }
                    return { kind: "complete", value: encoded };
                case FILE_FAILED_KIND:
                    return matches(fileFailedEventCodec.decodeRouting(encoded))
                        ? { kind: "complete", value: encoded }
                        : { kind: "ignore" };
                default:
                    return { kind: "ignore" };
            }
        },
        settled: () => upload,
    });
}

export async function requestComputerFile(
    socket: ComputerReplyConnection,
    command: FileReadCommandRouting,
    signal: AbortSignal,
): Promise<ComputerFileStream> {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Computer request timed out", "TimeoutError")),
        120_000,
    );
    const deadline = AbortSignal.any([signal, timeout.signal]);
    let settleFinished = () => {};
    const finished = new Promise<void>((resolve) => {
        settleFinished = resolve;
    });
    type TransferState =
        | { readonly kind: "waiting" }
        | {
              readonly kind: "streaming";
              readonly controller: ReadableStreamDefaultController<Uint8Array>;
              readonly receivedBytes: number;
              readonly nextSequence: number;
              readonly credit: "available" | "outstanding";
          }
        | { readonly kind: "finished" };
    let state: TransferState = { kind: "waiting" };
    // Bound opaque ciphertext, including encryption and binary routing overhead.
    // Only the decrypting client can enforce the exact plaintext byte length.
    const maxCiphertextBytes = Math.ceil(command.maxBytes / CONTENT_CHUNK_MAX_BYTES) * FILE_STREAM_MAX_CHUNK_BYTES;
    let cleanup = () => {};
    const response = await new Promise<Response>((resolve, reject) => {
        const finish = (completed: boolean): void => {
            if (state.kind === "finished") {
                return;
            }
            state = { kind: "finished" };
            clearTimeout(timer);
            cleanup();
            try {
                if (!completed) {
                    socket.cancel();
                }
            } catch (cause) {
                logger.warn(
                    { err: cause, event: "file_download_cancellation_failed" },
                    "File download cancellation failed",
                );
            } finally {
                try {
                    socket.close(1000, "Operation finished");
                } finally {
                    settleFinished();
                }
            }
        };
        const fail = (cause: unknown): void => {
            if (state.kind === "finished") {
                return;
            }
            if (state.kind === "streaming") {
                state.controller.error(cause);
            } else {
                reject(cause);
            }
            finish(false);
        };
        const startResponse = (encoded: string, terminal: boolean): void => {
            const record = encodeFileStreamRecord({ kind: "message", encoded });
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    state = { kind: "streaming", controller, receivedBytes: 0, nextSequence: 0, credit: "available" };
                    controller.enqueue(record);
                    if (terminal) {
                        controller.close();
                    }
                },
                pull() {
                    if (state.kind !== "streaming" || state.credit !== "available") {
                        return;
                    }
                    try {
                        deadline.throwIfAborted();
                        state = { ...state, credit: "outstanding" };
                        socket.creditFile();
                    } catch (cause) {
                        fail(cause);
                    }
                },
                cancel() {
                    finish(false);
                },
            });
            resolve(
                new Response(body, {
                    headers: {
                        "cache-control": "no-store",
                        "content-type": FILE_STREAM_CONTENT_TYPE,
                    },
                }),
            );
        };
        const onClose = (): void => fail(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
        const onAbort = (): void => fail(deadline.reason);
        const matches = (reply: { readonly requestId: string; readonly target: NativeSessionTarget }): boolean => {
            if (reply.requestId !== command.requestId) {
                return false;
            }
            if (
                reply.target.harness !== command.target.harness ||
                reply.target.sessionId !== command.target.sessionId
            ) {
                throw invalidComputerReply("The Computer returned an invalid file target");
            }
            return true;
        };
        const endStream = (encoded: string): void => {
            if (state.kind !== "streaming") {
                throw invalidComputerReply("The Computer ended an unknown file stream");
            }
            state.controller.enqueue(encodeFileStreamRecord({ kind: "message", encoded }));
            state.controller.close();
            finish(true);
        };
        const handlers: Readonly<Record<string, ((encoded: string) => void) | undefined>> = {
            [FILE_BEGIN_KIND]: (encoded) => {
                if (!matches(fileBeginEventCodec.decodeRouting(encoded))) {
                    return;
                }
                if (state.kind !== "waiting") {
                    throw invalidComputerReply("The Computer returned invalid file metadata");
                }
                startResponse(encoded, false);
            },
            [FILE_END_KIND]: (encoded) => {
                if (matches(fileEndEventCodec.decodeRouting(encoded))) {
                    endStream(encoded);
                }
            },
            [FILE_FAILED_KIND]: (encoded) => {
                if (!matches(fileFailedEventCodec.decodeRouting(encoded))) {
                    return;
                }
                if (state.kind === "waiting") {
                    startResponse(encoded, true);
                    finish(true);
                    return;
                }
                endStream(encoded);
            },
        };
        const onRejected = (event: Event): void => {
            if (event instanceof RequestRejectedEvent) {
                fail(new SessionRuntimeError(event.code, event.message));
            }
        };
        const onMessage = (event: Event): void => {
            if (!(event instanceof MessageEvent) || state.kind === "finished") {
                return;
            }
            try {
                if (typeof event.data !== "string") {
                    const chunk = contentChunkCodec.decodeRouting(event.data);
                    if (chunk.requestId !== command.requestId) {
                        return;
                    }
                    if (
                        state.kind !== "streaming" ||
                        state.credit !== "outstanding" ||
                        chunk.sequence !== state.nextSequence
                    ) {
                        throw invalidComputerReply("The Computer returned invalid file chunks");
                    }
                    const data: unknown = event.data;
                    let encoded: Uint8Array;
                    if (data instanceof ArrayBuffer) {
                        encoded = new Uint8Array(data);
                    } else if (ArrayBuffer.isView(data)) {
                        encoded = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                    } else {
                        throw invalidComputerReply("The Computer returned invalid file chunks");
                    }
                    const receivedBytes = state.receivedBytes + encoded.byteLength;
                    if (receivedBytes > maxCiphertextBytes) {
                        throw invalidComputerReply("The Computer exceeded the file size limit");
                    }
                    const controller = state.controller;
                    state = { ...state, receivedBytes, nextSequence: state.nextSequence + 1, credit: "available" };
                    controller.enqueue(encodeFileStreamRecord({ kind: "chunk", encoded }));
                    return;
                }
                handlers[decodeMessageKind(event.data)]?.(event.data);
            } catch (cause) {
                fail(
                    cause instanceof SessionRuntimeError
                        ? cause
                        : invalidComputerReply("The Computer returned an invalid file", {
                              cause,
                          }),
                );
            }
        };
        cleanup = () => {
            deadline.removeEventListener("abort", onAbort);
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("rejected", onRejected);
            socket.removeEventListener("offline", onClose);
            socket.removeEventListener("close", onClose);
            socket.removeEventListener("error", onClose);
        };
        socket.addEventListener("message", onMessage);
        socket.addEventListener("rejected", onRejected);
        socket.addEventListener("offline", onClose);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onClose);
        deadline.addEventListener("abort", onAbort, { once: true });
        try {
            deadline.throwIfAborted();
            socket.send(encodeClientToRelayMessage(command));
        } catch (cause) {
            fail(cause);
        }
    });
    return { finished, response };
}

export async function requestComputerAgentSettings(
    socket: ComputerReplyConnection,
    command: AgentSettingsDiscoverCommandRouting,
    signal: AbortSignal,
): Promise<string> {
    const encoded = encodeClientToRelayMessage(command);
    const handlers: Readonly<Record<string, ((message: string) => ReplyDecision<string>) | undefined>> = {
        "agent.settings.discovered": (message) => {
            const reply = agentSettingsDiscoveredEventCodec.decodeRouting(message);
            return reply.requestId === command.requestId && reply.harness === command.harness
                ? { kind: "complete", value: message }
                : { kind: "ignore" };
        },
        "agent.settings.discovery.failed": (message) => {
            const reply = agentSettingsDiscoveryFailedEventCodec.decodeRouting(message);
            return reply.requestId === command.requestId ? { kind: "complete", value: message } : { kind: "ignore" };
        },
    };
    return await awaitComputerReply(socket, signal, {
        send: () => socket.send(encoded),
        receive: (message, kind) => handlers[kind]?.(message) ?? { kind: "ignore" },
    });
}
