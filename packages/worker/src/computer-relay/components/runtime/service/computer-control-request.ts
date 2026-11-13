import {
    type AgentSettingsDiscoverCommand,
    type AgentSettingsDiscoveredEvent,
    CONTENT_AVAILABLE_KIND,
    CONTENT_CHUNK_MAX_BYTES,
    CONTENT_READY_KIND,
    type ComputerDiagnosticsRequest,
    type ComputerDiagnosticsResult,
    type ComputerPingCommand,
    type ComputerPongEvent,
    type ContentAvailableEvent,
    type ContentWriteCommand,
    decodeAgentSettingsDiscoveredEvent,
    decodeAgentSettingsDiscoveryFailedEvent,
    decodeComputerStatusEvent,
    decodeContentAvailableEvent,
    decodeContentChunkFrame,
    decodeContentReadyEvent,
    decodeFileBeginEvent,
    decodeFileEndEvent,
    decodeFileFailedEvent,
    decodeMessageKind,
    decodeSessionOperationFailedEvent,
    decodeWorkspaceEntriesEvent,
    encodeContentChunkFrame,
    encodeNativeSessionRequest,
    encodeServiceToDaemonMessage,
    FILE_BEGIN_KIND,
    FILE_END_KIND,
    FILE_FAILED_KIND,
    type FileReadCommand,
    type NativeSessionRequest,
    type NativeSessionResult,
    requestReplyAddress,
    type SessionArchiveCommand,
    type SessionArchivedEvent,
    type SessionCancelBeforeStartCommand,
    type SessionCancelCommand,
    type SessionConfigReadCommand,
    type SessionConfigReadResult,
    type SessionConfigUpdatedEvent,
    type SessionConfigureCommand,
    type SessionCreateCommand,
    type SessionElicitationRespondCommand,
    type SessionHistoryPageLoad,
    type SessionHistoryWirePageLoaded,
    type SessionInteractionAnsweredEvent,
    type SessionListCommand,
    type SessionPermissionRespondCommand,
    type SessionPrepareCommand,
    type SessionPreviewHistoryPageLoad,
    type SessionPreviewHistoryWirePageLoaded,
    type SessionPromptAcceptedEvent,
    type SessionPromptCommand,
    type SessionPromptDispositionCommand,
    type SessionPromptSteeredEvent,
    type SessionQueryCommand,
    type SessionReadyEvent,
    type SessionRenameCommand,
    type SessionRenamedEvent,
    type SessionRestoreCommand,
    type SessionRestoredEvent,
    type SessionsListedEvent,
    type SessionsQueriedEvent,
    type SessionTurnStoppedEvent,
    type SessionTurnWithdrawnEvent,
    type WorkspaceEntriesEvent,
    type WorkspaceListCommand,
} from "@morty-build/client/protocol";
import { RuntimeOperationFailedError, SessionRuntimeError } from "../../../../contracts/relay/session.ts";
import { computerControlRegistry } from "./computer-control-registry.ts";

export interface ComputerReplyConnection {
    readonly readyState: number;
    readonly accept: () => void;
    readonly send: (message: string | ArrayBuffer | ArrayBufferView) => void;
    readonly close: (code?: number, reason?: string) => void;
    readonly addEventListener: EventTarget["addEventListener"];
    readonly removeEventListener: EventTarget["removeEventListener"];
}

export type ComputerControlCommand =
    | ComputerDiagnosticsRequest
    | ComputerPingCommand
    | NativeSessionRequest
    | SessionPrepareCommand
    | SessionCreateCommand
    | SessionConfigureCommand
    | SessionConfigReadCommand
    | SessionRenameCommand
    | SessionArchiveCommand
    | SessionCancelBeforeStartCommand
    | SessionCancelCommand
    | SessionPromptDispositionCommand
    | SessionPromptCommand
    | SessionPreviewHistoryPageLoad
    | SessionHistoryPageLoad
    | SessionElicitationRespondCommand
    | SessionPermissionRespondCommand
    | SessionListCommand
    | SessionQueryCommand
    | SessionRestoreCommand;

export type ComputerControlResult =
    | ComputerDiagnosticsResult
    | ComputerPongEvent
    | NativeSessionResult
    | SessionReadyEvent
    | SessionConfigUpdatedEvent
    | SessionConfigReadResult
    | SessionRenamedEvent
    | SessionArchivedEvent
    | SessionPromptAcceptedEvent
    | SessionPromptSteeredEvent
    | SessionTurnStoppedEvent
    | SessionTurnWithdrawnEvent
    | SessionPreviewHistoryWirePageLoaded
    | SessionHistoryWirePageLoaded
    | SessionInteractionAnsweredEvent
    | SessionsListedEvent
    | SessionsQueriedEvent
    | SessionRestoredEvent;

export interface ComputerFileStream {
    readonly finished: Promise<void>;
    readonly response: Response;
}

/** How long the Computer has to answer one request. */
const COMPUTER_REQUEST_TIMEOUT_MILLISECONDS = 120_000;

/** The deadline of one Computer request: the caller's signal or the request timeout, whichever ends first. */
function computerRequestDeadline(signal: AbortSignal): {
    readonly deadline: AbortSignal;
    readonly release: () => void;
} {
    const timeout = new AbortController();
    const timer = setTimeout(
        () => timeout.abort(new DOMException("Computer request timed out", "TimeoutError")),
        COMPUTER_REQUEST_TIMEOUT_MILLISECONDS,
    );
    return { deadline: AbortSignal.any([signal, timeout.signal]), release: () => clearTimeout(timer) };
}

const computerOffline = (): SessionRuntimeError =>
    new SessionRuntimeError("computer_offline", "The Computer connection closed");

/** What one daemon message means to a request awaiting its reply. */
type ReplyStep<Reply> =
    | { readonly kind: "ignore" }
    | { readonly kind: "reply"; readonly reply: Reply }
    | { readonly kind: "failure"; readonly error: Error };

const ignored = { kind: "ignore" } as const;

/** What a request does with the Computer's messages; the rules every request shares live in `awaitComputerReply`. */
interface ComputerExchange<Reply> {
    /** Sends the request, once the exchange is listening. */
    readonly send: () => void;
    /**
     * Decides what a text message from the Computer means to this request. A throw is an invalid reply. `fail` ends the
     * exchange for work the request does on its own, and `deadline` ends with the exchange.
     */
    readonly receive: (
        data: string,
        kind: string,
        exchange: { readonly fail: (cause: unknown) => void; readonly deadline: AbortSignal },
    ) => ReplyStep<Reply>;
    /** Runs when the exchange ends before the Computer replied, on the open connection. */
    readonly abandoned?: () => void;
    /** Resolves when work the request started on its own has ended; the connection closes after it. */
    readonly settled?: () => Promise<void>;
}

/**
 * Runs a request that ends with one reply from the Computer. Every such request shares one deadline and one meaning
 * for the Computer going offline, the connection closing and an unreadable reply; each ends with the connection
 * released, whatever the outcome.
 */
async function awaitComputerReply<Reply>(
    socket: ComputerReplyConnection,
    signal: AbortSignal,
    exchange: ComputerExchange<Reply>,
): Promise<Reply> {
    const { deadline, release } = computerRequestDeadline(signal);
    let cleanup = () => {};
    try {
        return await new Promise<Reply>((resolve, reject) => {
            const onClose = (): void => reject(computerOffline());
            const onAbort = (): void => {
                exchange.abandoned?.();
                reject(deadline.reason);
            };
            const onMessage = (event: Event): void => {
                if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
                    return;
                }
                try {
                    const kind = decodeMessageKind(event.data);
                    if (kind === "computer.status") {
                        if (!decodeComputerStatusEvent(event.data).online) {
                            onClose();
                        }
                        return;
                    }
                    const step = exchange.receive(event.data, kind, { fail: reject, deadline });
                    if (step.kind === "reply") {
                        resolve(step.reply);
                    } else if (step.kind === "failure") {
                        reject(step.error);
                    }
                } catch (cause) {
                    reject(
                        cause instanceof SessionRuntimeError
                            ? cause
                            : new SessionRuntimeError("invalid_request", "The Computer returned an invalid response", {
                                  cause,
                              }),
                    );
                }
            };
            cleanup = () => {
                deadline.removeEventListener("abort", onAbort);
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onClose);
            };
            socket.addEventListener("message", onMessage);
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onClose);
            deadline.addEventListener("abort", onAbort, { once: true });
            try {
                deadline.throwIfAborted();
                socket.accept();
                exchange.send();
            } catch (cause) {
                reject(cause);
            }
        });
    } finally {
        release();
        cleanup();
        await exchange.settled?.().catch(() => undefined);
        socket.close(1000, "Operation finished");
    }
}

export async function requestComputerContentWrite(
    socket: ComputerReplyConnection,
    command: ContentWriteCommand,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
): Promise<ContentAvailableEvent> {
    let uploadStarted = false;
    let upload: Promise<void> = Promise.resolve();
    const sendBody = async (deadline: AbortSignal): Promise<void> => {
        const reader = body.getReader();
        let sequence = 0;
        let sentBytes = 0;
        try {
            while (true) {
                deadline.throwIfAborted();
                const chunk = await reader.read();
                if (chunk.done) {
                    break;
                }
                for (let offset = 0; offset < chunk.value.byteLength; offset += CONTENT_CHUNK_MAX_BYTES) {
                    const bytes = chunk.value.subarray(offset, offset + CONTENT_CHUNK_MAX_BYTES);
                    sentBytes += bytes.byteLength;
                    if (sentBytes > command.byteLength) {
                        throw new SessionRuntimeError("invalid_request", "The content body exceeds its declared size");
                    }
                    socket.send(encodeContentChunkFrame({ bytes, requestId: command.requestId, sequence }));
                    sequence += 1;
                }
            }
            if (sentBytes !== command.byteLength) {
                throw new SessionRuntimeError("invalid_request", "The content body has an unexpected size");
            }
            socket.send(
                encodeServiceToDaemonMessage({
                    kind: "content.commit",
                    requestId: command.requestId,
                    target: command.target,
                }),
            );
        } finally {
            reader.releaseLock();
        }
    };
    return await awaitComputerReply<ContentAvailableEvent>(socket, signal, {
        send: () => socket.send(encodeServiceToDaemonMessage(command)),
        receive: (data, kind, { fail, deadline }) => {
            switch (kind) {
                case FILE_FAILED_KIND: {
                    const failure = decodeFileFailedEvent(data);
                    return failure.requestId === command.requestId
                        ? { kind: "failure", error: new SessionRuntimeError(failure.code, failure.message) }
                        : ignored;
                }
                case CONTENT_READY_KIND: {
                    const ready = decodeContentReadyEvent(data);
                    if (ready.requestId === command.requestId && !uploadStarted) {
                        uploadStarted = true;
                        upload = sendBody(deadline).catch(fail);
                    }
                    return ignored;
                }
                case CONTENT_AVAILABLE_KIND: {
                    const available = decodeContentAvailableEvent(data);
                    if (available.requestId !== command.requestId) {
                        return ignored;
                    }
                    if (available.contentKey !== command.contentKey || available.byteLength !== command.byteLength) {
                        throw new SessionRuntimeError(
                            "invalid_request",
                            "The Computer returned invalid content metadata",
                        );
                    }
                    return { kind: "reply", reply: available };
                }
                default:
                    return ignored;
            }
        },
        settled: () => upload,
    });
}

export async function requestComputerFile(
    socket: ComputerReplyConnection,
    command: FileReadCommand,
    signal: AbortSignal,
): Promise<ComputerFileStream> {
    const { deadline, release: releaseDeadline } = computerRequestDeadline(signal);
    let settleFinished = () => {};
    const finished = new Promise<void>((resolve) => {
        settleFinished = resolve;
    });
    let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
    let responseSettled = false;
    let transferFinished = false;
    let expectedBytes = 0;
    let receivedBytes = 0;
    let nextSequence = 0;
    let cleanup = () => {};
    const response = await new Promise<Response>((resolve, reject) => {
        const finish = (): void => {
            if (transferFinished) {
                return;
            }
            transferFinished = true;
            releaseDeadline();
            cleanup();
            socket.close(1000, "Operation finished");
            settleFinished();
        };
        const fail = (cause: unknown): void => {
            if (transferFinished) {
                return;
            }
            if (responseSettled) {
                stream?.error(cause);
            } else {
                reject(cause);
            }
            finish();
        };
        const onClose = (): void => fail(new SessionRuntimeError("computer_offline", "The Computer connection closed"));
        const onAbort = (): void => fail(deadline.reason);
        const onMessage = (event: Event): void => {
            if (!(event instanceof MessageEvent)) {
                return;
            }
            try {
                if (typeof event.data !== "string") {
                    const chunk = decodeContentChunkFrame(event.data);
                    if (chunk.requestId !== command.requestId) {
                        return;
                    }
                    if (!responseSettled || chunk.sequence !== nextSequence) {
                        throw new SessionRuntimeError("invalid_request", "The Computer returned invalid file chunks");
                    }
                    receivedBytes += chunk.bytes.byteLength;
                    if (receivedBytes > command.maxBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Computer exceeded the file size limit");
                    }
                    nextSequence += 1;
                    stream?.enqueue(chunk.bytes);
                    return;
                }
                const kind = decodeMessageKind(event.data);
                if (kind === "computer.status") {
                    if (!decodeComputerStatusEvent(event.data).online) {
                        onClose();
                    }
                    return;
                }
                if (kind === FILE_FAILED_KIND) {
                    const failure = decodeFileFailedEvent(event.data);
                    if (failure.requestId === command.requestId) {
                        fail(new SessionRuntimeError(failure.code, failure.message));
                    }
                    return;
                }
                if (kind === FILE_BEGIN_KIND) {
                    const begin = decodeFileBeginEvent(event.data);
                    if (begin.requestId !== command.requestId) {
                        return;
                    }
                    if (responseSettled || begin.byteLength > command.maxBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Computer returned invalid file metadata");
                    }
                    const body = new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                        cancel() {
                            finish();
                        },
                    });
                    responseSettled = true;
                    expectedBytes = begin.byteLength;
                    resolve(
                        new Response(body, {
                            headers: {
                                "cache-control": "no-store",
                                "content-length": begin.byteLength.toString(),
                                "content-type": begin.mediaType,
                                "last-modified": new Date(begin.modifiedAt).toUTCString(),
                                "x-morty-byte-length": begin.byteLength.toString(),
                                "x-morty-file-name": encodeURIComponent(begin.name),
                            },
                        }),
                    );
                    return;
                }
                if (kind === FILE_END_KIND) {
                    const end = decodeFileEndEvent(event.data);
                    if (end.requestId !== command.requestId) {
                        return;
                    }
                    if (!responseSettled || receivedBytes !== expectedBytes) {
                        throw new SessionRuntimeError("invalid_request", "The Computer ended an unknown file stream");
                    }
                    stream?.close();
                    finish();
                }
            } catch (cause) {
                fail(
                    cause instanceof SessionRuntimeError
                        ? cause
                        : new SessionRuntimeError("invalid_request", "The Computer returned an invalid file", {
                              cause,
                          }),
                );
            }
        };
        cleanup = () => {
            deadline.removeEventListener("abort", onAbort);
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("close", onClose);
            socket.removeEventListener("error", onClose);
        };
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onClose);
        deadline.addEventListener("abort", onAbort, { once: true });
        try {
            deadline.throwIfAborted();
            socket.accept();
            socket.send(encodeServiceToDaemonMessage(command));
        } catch (cause) {
            fail(cause);
        }
    });
    return { finished, response };
}

export async function requestComputerAgentSettings(
    socket: ComputerReplyConnection,
    command: AgentSettingsDiscoverCommand,
    signal: AbortSignal,
): Promise<AgentSettingsDiscoveredEvent> {
    return await awaitComputerReply<AgentSettingsDiscoveredEvent>(socket, signal, {
        send: () => socket.send(encodeServiceToDaemonMessage(command)),
        receive: (data, kind) => {
            if (kind === "agent.settings.discovery.failed") {
                const failed = decodeAgentSettingsDiscoveryFailedEvent(data);
                return failed.requestId === command.requestId
                    ? { kind: "failure", error: new SessionRuntimeError(failed.code, failed.message) }
                    : ignored;
            }
            if (kind !== "agent.settings.discovered") {
                return ignored;
            }
            const result = decodeAgentSettingsDiscoveredEvent(data);
            return result.requestId === command.requestId ? { kind: "reply", reply: result } : ignored;
        },
    });
}

/** The Computer's own refusal of the request `requestId`: it finished handling it without a result. */
function operationFailure(data: string, requestId: string): ReplyStep<never> {
    const failed = decodeSessionOperationFailedEvent(data);
    return failed.requestId === requestId
        ? {
              kind: "failure",
              error: new RuntimeOperationFailedError(failed.code, failed.message, {
                  runtimeTimings: failed.runtimeTimings,
              }),
          }
        : ignored;
}

export async function requestComputerControl(
    socket: ComputerReplyConnection,
    command: ComputerControlCommand,
    signal: AbortSignal,
): Promise<ComputerControlResult> {
    const reply = computerControlRegistry[command.kind];
    const requestId = requestReplyAddress(command);
    return await awaitComputerReply<ComputerControlResult>(socket, signal, {
        send: () =>
            socket.send(
                command.kind === "native.session.request"
                    ? encodeNativeSessionRequest(command)
                    : encodeServiceToDaemonMessage(command),
            ),
        receive: (data, kind) => {
            if (kind === "session.operation.failed") {
                return operationFailure(data, requestId);
            }
            if (kind !== reply.eventKind) {
                return ignored;
            }
            const resolved = reply.decode(data);
            return resolved.requestId === requestId ? { kind: "reply", reply: resolved } : ignored;
        },
        abandoned: () => {
            if (command.kind === "native.session.request" && socket.readyState === WebSocket.OPEN) {
                socket.send(
                    encodeServiceToDaemonMessage({ kind: "native.session.cancel", requestId: command.requestId }),
                );
            }
        },
    });
}

export async function requestComputerWorkspace(
    socket: ComputerReplyConnection,
    command: WorkspaceListCommand,
    signal: AbortSignal,
): Promise<WorkspaceEntriesEvent> {
    return await awaitComputerReply<WorkspaceEntriesEvent>(socket, signal, {
        send: () => socket.send(encodeServiceToDaemonMessage(command)),
        receive: (data, kind) => {
            if (kind === "session.operation.failed") {
                return operationFailure(data, command.requestId);
            }
            if (kind !== "workspace.entries") {
                return ignored;
            }
            const result = decodeWorkspaceEntriesEvent(data);
            return result.requestId === command.requestId ? { kind: "reply", reply: result } : ignored;
        },
    });
}
