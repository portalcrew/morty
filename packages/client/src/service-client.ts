import {
    CONTENT_CHUNK_MAX_BYTES,
    CONTENT_UPLOAD_MAX_ENCODED_BYTES,
    CONTENT_WRITE_MAX_BYTES,
    decodeKnownSessionEventLogPage,
    decodeKnownSessionLiveEventBatch,
    decodeMessageKind,
    decodePromptAttachment,
    decodeTurn,
    decodeTurnCancellation,
    decodeTurnReference,
    type ExternalAudioContentBlock,
    type ExternalImageContentBlock,
    type ExternalResourceContentBlock,
    MORTY_API_PREFIX,
    type NativeSessionTarget,
    type PromptAttachment,
    ProtocolMessageError,
    SESSION_CLOSED_ERROR_CODE,
    type SessionConfigurationSelection,
    type SessionEventLogPage,
    type SessionExecution,
    type SessionLiveEventBatch,
    type SessionOperationFailedEvent,
    SessionPromptDisposition,
    type Turn,
    type TurnReference,
} from "@morty-build/client/protocol";
import type { MortyEndpointCall } from "./calls/call.ts";
import { sessionEndpoints } from "./calls/session.ts";
import type { ComputerEncryptionAccess, PayloadDecryptor } from "./encryption.ts";
import {
    MortyApiError,
    MortyCancellationError,
    MortyConnectionError,
    MortyError,
    MortyOperationError,
    MortyProtocolError,
    MortyTimeoutError,
    MortyValidationError,
} from "./errors.ts";
import { sameNativeSession } from "./native-session.ts";
import {
    sessionConfigReadCommandCodec,
    sessionConfigReadResultCodec,
    sessionConfigUpdatedEventCodec,
    sessionConfigureCommandCodec,
} from "./protocol/session/configuration/index.ts";
import { sessionRenameCommandCodec, sessionRenamedEventCodec } from "./protocol/session/configuration/title.ts";
import {
    decodeSessionEventEnvelope,
    sessionEventEnvelopeCodec,
    sessionEventsSubscribeCommandCodec,
} from "./protocol/session/events/index.ts";
import {
    contentAvailableEventCodec,
    contentChunkCodec,
    contentCommitCommandCodec,
    contentWriteCommandCodec,
    decodeFileStreamRecord,
    encodeFileStreamRecord,
    FILE_STREAM_CONTENT_TYPE,
    FILE_STREAM_MAX_CHUNK_BYTES,
    FILE_STREAM_MAX_MESSAGE_BYTES,
    type FileBeginEvent,
    type FileStreamRecord,
    fileBeginEventCodec,
    fileEndEventCodec,
    fileFailedEventCodec,
    fileReadCommandCodec,
} from "./protocol/session/files/index.ts";
import {
    sessionElicitationRespondCommandCodec,
    sessionInteractionAnsweredEventCodec,
    sessionPermissionRespondCommandCodec,
} from "./protocol/session/interactions/index.ts";
import {
    decodeSessionCloseNoticeEvent,
    sessionCloseNoticeEventCodec,
    sessionOperationFailedEventCodec,
    sessionPromptAcceptedEventCodec,
} from "./protocol/session/lifecycle/index.ts";
import { nativeSessionCommandCodec, nativeSessionResultCodec } from "./protocol/session/native/index.ts";
import {
    sessionHistoryPageLoadCodec,
    sessionHistoryPageLoadedCodec,
} from "./protocol/session/observability/history.ts";
import {
    sessionCancelBeforeStartCommandCodec,
    sessionCancelCommandCodec,
    sessionPromptCommandCodec,
    sessionPromptDispositionCommandCodec,
    sessionPromptSteeredEventCodec,
    sessionTurnStoppedEventCodec,
    sessionTurnWithdrawnEventCodec,
} from "./protocol/session/prompt/commands.ts";
import type {
    MortyInteractionResponseRequest,
    MortyPageRequest,
    MortyTurnCancellation,
    SubmitMortyTurnRequest,
} from "./resources.ts";
import { executeLiveDeliveryOnce } from "./transport/live-delivery.ts";
import type { MortyTransportSessionEvent, WsTransport } from "./transport/ws-transport.ts";

function sanitizedConnectionCauseMessage(value: string): string {
    return Array.from(value, (character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
    })
        .join("")
        .trim()
        .slice(0, 1_024);
}

function connectionCauseMessages(cause: unknown): readonly string[] {
    const messages: string[] = [];
    const visited = new Set<unknown>();
    let current = cause;
    while (current instanceof Error && messages.length < 4 && !visited.has(current)) {
        visited.add(current);
        const message = sanitizedConnectionCauseMessage(current.message);
        if (message.length > 0) {
            messages.push(message);
        }
        current = current.cause;
    }
    return messages;
}

export interface MortyCredentialProvider {
    readonly credential: (signal: AbortSignal) => Promise<string>;
}

/** A Session setting change. */
export type UpdateMortySessionConfigurationRequest = SessionConfigurationSelection & {
    readonly expectedConfigurationRevision: string;
};

export interface ForkMortyNativeSessionRequest {
    readonly harness: string;
    readonly sessionId: string;
    readonly directory: string;
}

export type MortyExternalContentBlock =
    | ExternalImageContentBlock
    | ExternalAudioContentBlock
    | ExternalResourceContentBlock;

export function externalContentPath(content: MortyExternalContentBlock): string {
    let kind: "audio" | "image" | "resource";
    let key: string;
    switch (content.type) {
        case "external_image":
            kind = "image";
            key = content.imageKey;
            break;
        case "external_audio":
            kind = "audio";
            key = content.audioKey;
            break;
        case "external_resource":
            kind = "resource";
            key = content.resourceKey;
            break;
        default:
            throw new MortyValidationError("The external content reference is invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(key)) {
        throw new MortyValidationError("The external content key is invalid");
    }
    return `morty-content:${kind}:${key}`;
}

function validateCredential(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 4_096 ||
        value.includes("\r") ||
        value.includes("\n")
    ) {
        throw new MortyValidationError("The Morty credential is invalid");
    }
    return value;
}

export interface MortyResponseMetadata {
    readonly serverTiming: string | null;
    readonly status: number;
}

export interface MortyEndpointOptions {
    readonly credentialProvider: MortyCredentialProvider;
    readonly endpoint: string;
    readonly observeResponse?: (metadata: MortyResponseMetadata) => void;
    readonly operationTimeoutMilliseconds?: number;
}

export interface MortyClientOptions extends MortyEndpointOptions {
    readonly computerId: string;
    /** Owned by the Computer; closing this client does not close its transport. */
    readonly transport: WsTransport;
    readonly encryption: { readonly access: ComputerEncryptionAccess };
    /** Releases the owner's registration after this client's resources close. */
    readonly onClose?: () => void;
}

function validatePositiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new MortyValidationError(`The ${name} is invalid`);
    }
    return value;
}

function normalizeEndpoint(value: string): URL {
    let endpoint: URL;
    try {
        endpoint = new URL(value);
    } catch (cause) {
        throw new MortyValidationError("The Morty endpoint is invalid", {
            cause,
        });
    }
    if (
        (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        endpoint.search.length > 0 ||
        endpoint.hash.length > 0
    ) {
        throw new MortyValidationError("The Morty endpoint is invalid");
    }
    if (endpoint.pathname === "/") {
        endpoint.pathname = `${MORTY_API_PREFIX}/`;
    } else if (!endpoint.pathname.endsWith("/")) {
        endpoint.pathname = `${endpoint.pathname}/`;
    }
    return endpoint;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new MortyProtocolError("The service returned an invalid error response");
    }
    return value;
}

/** The Computer's refusals: the operation was not run, so repeating it under a new identity cannot run it twice. */
const refusedOperationCodes = new Set([
    "invalid_request",
    "session_not_found",
    "native_session_not_found",
    "native_session_unsupported",
    "native_session_cursor_expired",
    "native_session_target_changed",
    "unsupported_operation",
    "session_busy",
    SESSION_CLOSED_ERROR_CODE,
    "idempotency_conflict",
    "command_identity_conflict",
    "session_creation_refused",
    "turn_already_started",
    "turn_not_active",
    "permission_response_conflict",
    "elicitation_response_conflict",
    "session_configuration_conflict",
    "steering_target_unavailable",
    "steering_unsupported",
]);

/** A command that already started: its result is gone, but the Computer will not run it again. */
const appliedOperationCodes = new Set(["command_result_expired"]);

function operationOutcome(code: string): MortyOperationError["outcome"] {
    if (refusedOperationCodes.has(code)) {
        return "refused";
    }
    return appliedOperationCodes.has(code) ? "applied" : "unknown";
}

function throwNativeFailure(
    failure: SessionOperationFailedEvent,
    requestId: string,
    target: NativeSessionTarget,
): never {
    if (
        failure.requestId !== requestId ||
        (failure.target !== undefined && !sameNativeSession(failure.target, target))
    ) {
        throw new MortyProtocolError("The Computer returned a failure for another request");
    }
    if (failure.code === "native_session_cancelled" || failure.code === "operation_cancelled") {
        throw new MortyCancellationError({ cause: failure });
    }
    if (failure.code === "native_session_timeout" || failure.code === "operation_timeout") {
        throw new MortyTimeoutError({ cause: failure });
    }
    throw new MortyOperationError(failure.code, failure.message, operationOutcome(failure.code), { cause: failure });
}

async function responseValue(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch (cause) {
        throw new MortyProtocolError("The service returned invalid JSON", {
            cause,
        });
    }
}

async function throwApiError(response: Response): Promise<never> {
    const value = record(await responseValue(response));
    const error = record(value["error"]);
    const code = error["code"];
    const message = error["message"];
    if (typeof code !== "string" || typeof message !== "string") {
        throw new MortyProtocolError("The service returned an invalid error response");
    }
    throw new MortyApiError(code, message, response.status);
}

class RequestDeadline {
    readonly #controller = new AbortController();
    readonly #requestSignal: AbortSignal;
    readonly #timeoutId: ReturnType<typeof globalThis.setTimeout>;
    #timedOut = false;

    constructor(requestSignal: AbortSignal, timeoutMilliseconds: number) {
        this.#requestSignal = requestSignal;
        if (requestSignal.aborted) {
            this.#controller.abort(requestSignal.reason);
        } else {
            requestSignal.addEventListener("abort", this.abortFromRequest, {
                once: true,
            });
        }
        this.#timeoutId = globalThis.setTimeout(this.abortFromTimeout, timeoutMilliseconds);
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    readonly finish = (): void => {
        globalThis.clearTimeout(this.#timeoutId);
        this.#requestSignal.removeEventListener("abort", this.abortFromRequest);
    };

    readonly translate = (cause: unknown): never => {
        if (this.#requestSignal.aborted) {
            throw new MortyCancellationError({ cause });
        }
        if (this.#timedOut) {
            throw new MortyTimeoutError({ cause });
        }
        if (cause instanceof MortyError) {
            throw cause;
        }
        throw new MortyConnectionError("The Morty service could not be reached", {
            cause,
        });
    };

    private readonly abortFromRequest = (): void => {
        this.#controller.abort(this.#requestSignal.reason);
    };

    private readonly abortFromTimeout = (): void => {
        this.#timedOut = true;
        this.#controller.abort(new Error("The Morty operation timed out"));
    };
}

type FileDownloadState =
    | { readonly kind: "begin" }
    | {
          readonly kind: "chunks";
          readonly begin: FileBeginEvent;
          readonly bytes: Uint8Array;
          readonly offset: number;
          readonly sequence: number;
      }
    | { readonly kind: "end"; readonly begin: FileBeginEvent; readonly bytes: Uint8Array };

/** What the reader asked for: every record of the answer must carry this address and Session. */
interface FileDownloadRequest {
    readonly requestId: string;
    readonly target: NativeSessionTarget;
    readonly maximumBytes: number;
}

async function consumeFileRecord(
    record: FileStreamRecord,
    state: FileDownloadState,
    request: FileDownloadRequest,
    decryptor: PayloadDecryptor,
    signal: AbortSignal,
): Promise<FileDownloadState> {
    if (state.kind === "end") {
        throw new MortyProtocolError("The encrypted file contains trailing records");
    }
    if (record.kind === "chunk") {
        if (state.kind !== "chunks") {
            throw new MortyProtocolError("The encrypted file chunk precedes its metadata");
        }
        const chunk = await contentChunkCodec.decode(record.encoded, decryptor, signal);
        if (
            chunk.requestId !== request.requestId ||
            chunk.sequence !== state.sequence ||
            state.offset + chunk.bytes.byteLength > state.bytes.byteLength
        ) {
            throw new MortyProtocolError("The encrypted file contains invalid chunks");
        }
        state.bytes.set(chunk.bytes, state.offset);
        return { ...state, offset: state.offset + chunk.bytes.byteLength, sequence: state.sequence + 1 };
    }
    const kind = decodeMessageKind(record.encoded);
    if (kind === "file.failed") {
        const failure = await fileFailedEventCodec.decode(record.encoded, decryptor, signal);
        if (!sameNativeSession(failure.target, request.target) || failure.requestId !== request.requestId) {
            throw new MortyProtocolError("The Computer returned a file failure for another request");
        }
        throw new MortyError(failure.code, failure.message, { cause: failure });
    }
    if (kind === "file.begin" && state.kind === "begin") {
        const begin = await fileBeginEventCodec.decode(record.encoded, decryptor, signal);
        if (
            begin.requestId !== request.requestId ||
            !sameNativeSession(begin.target, request.target) ||
            begin.byteLength > request.maximumBytes
        ) {
            throw new MortyProtocolError("The Computer returned invalid file metadata");
        }
        return { kind: "chunks", begin, bytes: new Uint8Array(begin.byteLength), offset: 0, sequence: 0 };
    }
    if (kind === "file.end" && state.kind === "chunks") {
        const end = await fileEndEventCodec.decode(record.encoded, decryptor, signal);
        if (
            end.requestId !== request.requestId ||
            !sameNativeSession(end.target, request.target) ||
            state.offset !== state.bytes.byteLength
        ) {
            throw new MortyProtocolError("The encrypted file ended before it was complete");
        }
        return { kind: "end", begin: state.begin, bytes: state.bytes };
    }
    throw new MortyProtocolError("The encrypted file contains an unexpected message");
}

async function readEncryptedFile(
    response: Response,
    request: FileDownloadRequest,
    decryptor: PayloadDecryptor,
    signal: AbortSignal,
): Promise<{
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly modifiedAt: string;
    readonly name: string;
}> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new MortyProtocolError("The service returned no encrypted file content");
    }
    let state: FileDownloadState = { kind: "begin" };
    let buffer = new Uint8Array(5);
    let used = 0;
    let completed = false;
    try {
        while (true) {
            signal.throwIfAborted();
            const part = await reader.read();
            signal.throwIfAborted();
            if (part.done) {
                break;
            }
            let offset = 0;
            while (offset < part.value.byteLength) {
                if (state.kind === "end") {
                    throw new MortyProtocolError("The encrypted file contains trailing data");
                }
                const count = Math.min(buffer.byteLength - used, part.value.byteLength - offset);
                buffer.set(part.value.subarray(offset, offset + count), used);
                used += count;
                offset += count;
                if (used < buffer.byteLength) {
                    continue;
                }
                if (buffer.byteLength === 5) {
                    decodeFileStreamRecord(buffer);
                    const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(1);
                    const next = new Uint8Array(5 + length);
                    next.set(buffer);
                    buffer = next;
                    continue;
                }
                const decoded = decodeFileStreamRecord(buffer);
                if (decoded.kind !== "record" || decoded.byteLength !== buffer.byteLength) {
                    throw new MortyProtocolError("The encrypted file record is incomplete");
                }
                state = await consumeFileRecord(decoded.record, state, request, decryptor, signal);
                buffer = new Uint8Array(5);
                used = 0;
            }
        }
        if (used !== 0 || state.kind !== "end") {
            throw new MortyProtocolError("The encrypted file is incomplete");
        }
        completed = true;
        return {
            bytes: state.bytes,
            mediaType: state.begin.mediaType,
            modifiedAt: state.begin.modifiedAt,
            name: state.begin.name,
        };
    } finally {
        if (!completed) {
            await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
    }
}

class LiveEventConnection {
    readonly events: ReadableStream<MortyTransportSessionEvent>;
    readonly #controller: AbortController;
    readonly #release: () => void;
    #closed = false;

    constructor(events: ReadableStream<MortyTransportSessionEvent>, controller: AbortController, release: () => void) {
        this.events = events;
        this.#controller = controller;
        this.#release = release;
    }

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#controller.abort(new Error("The live Session event connection closed"));
        this.#release();
    };
}

export class MortyRequestExecutor {
    readonly #credentialProvider: MortyCredentialProvider;
    readonly #endpoint: URL;
    readonly #operationTimeoutMilliseconds: number | undefined;
    readonly #observeResponse: ((metadata: MortyResponseMetadata) => void) | undefined;
    readonly #transport: WsTransport;
    readonly #lifetime = new AbortController();

    constructor(options: MortyEndpointOptions, transport: WsTransport) {
        this.#transport = transport;
        this.#credentialProvider = options.credentialProvider;
        this.#endpoint = normalizeEndpoint(options.endpoint);
        this.#operationTimeoutMilliseconds =
            options.operationTimeoutMilliseconds === undefined
                ? undefined
                : validatePositiveInteger(options.operationTimeoutMilliseconds, "operation timeout");
        this.#observeResponse = options.observeResponse;
    }

    readonly close = (): void => this.#lifetime.abort(new MortyConnectionError("The Morty client is closed"));

    get payloadEncryption() {
        return this.#transport.payloadEncryption;
    }

    readonly get = async (endpoint: MortyEndpointCall, body: string, signal: AbortSignal): Promise<string> =>
        await this.request(endpoint, body, "application/json", signal);

    /** Sends the encrypted file read and returns the file only when every record of the answer answers that read. */
    readonly readFileStream = async (
        endpoint: MortyEndpointCall,
        body: string,
        request: FileDownloadRequest,
        signal: AbortSignal,
    ): Promise<{
        readonly bytes: Uint8Array;
        readonly mediaType: string;
        readonly modifiedAt: string;
        readonly name: string;
    }> => {
        const deadline = new RequestDeadline(
            AbortSignal.any([signal, this.#lifetime.signal]),
            this.#operationTimeoutMilliseconds ?? endpoint.timeoutMilliseconds,
        );
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const response = await this.#transport.fetch({
                endpoint,
                origin: this.#endpoint,
                body,
                headers: {
                    ...this.authenticationHeaders(credential, "application/vnd.morty.encrypted-file"),
                    "content-type": "application/json",
                },
                signal: deadline.signal,
            });
            this.#observeResponse?.({ serverTiming: response.headers.get("server-timing"), status: response.status });
            if (!response.ok) {
                await throwApiError(response);
            }
            if (
                response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
                "application/vnd.morty.encrypted-file"
            ) {
                throw new MortyProtocolError("The Computer returned an invalid encrypted file response");
            }
            return await readEncryptedFile(response, request, this.#transport.payloadEncryption, deadline.signal);
        } catch (cause) {
            if (!signal.aborted) {
                this.#lifetime.signal.throwIfAborted();
            }
            if (cause instanceof ProtocolMessageError) {
                throw new MortyProtocolError("The Computer returned an invalid encrypted file", { cause });
            }
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    readonly post = async (endpoint: MortyEndpointCall, body: string, signal: AbortSignal): Promise<string> =>
        await this.request(endpoint, body, "application/json", signal);

    readonly put = async (endpoint: MortyEndpointCall, body: string, signal: AbortSignal): Promise<string> =>
        await this.request(endpoint, body, "application/json", signal);

    readonly putBinary = async (
        endpoint: MortyEndpointCall,
        body: Uint8Array,
        contentType: string,
        signal: AbortSignal,
    ): Promise<string> => await this.request(endpoint, body, contentType, signal);

    readonly openLiveEventStream = async (
        endpoint: MortyEndpointCall,
        body: string,
        subscriptionId: string,
        signal: AbortSignal,
    ): Promise<LiveEventConnection> => {
        signal = AbortSignal.any([signal, this.#lifetime.signal]);
        signal.throwIfAborted();
        const controller = new AbortController();
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const timeoutId = globalThis.setTimeout(
            () => controller.abort(new Error("The live Session event connection timed out")),
            endpoint.timeoutMilliseconds,
        );
        const release = (): void => {
            globalThis.clearTimeout(timeoutId);
            signal.removeEventListener("abort", abort);
        };
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(controller.signal));
            const events = await this.#transport.openSessionLiveEvents(
                {
                    endpoint,
                    origin: this.#endpoint,
                    body,
                    headers: {
                        ...this.authenticationHeaders(credential, "application/json"),
                        "content-type": "application/json",
                    },
                    signal: controller.signal,
                },
                subscriptionId,
            );
            globalThis.clearTimeout(timeoutId);
            return new LiveEventConnection(events, controller, release);
        } catch (cause) {
            release();
            if (signal.aborted) {
                throw new MortyCancellationError({ cause });
            }
            if (cause instanceof MortyError) {
                throw cause;
            }
            throw new MortyConnectionError("The live Session event stream could not connect", { cause });
        }
    };

    private readonly request = async (
        endpoint: MortyEndpointCall,
        body: string | Uint8Array,
        contentType: string,
        signal: AbortSignal,
    ): Promise<string> => {
        const deadline = new RequestDeadline(
            AbortSignal.any([signal, this.#lifetime.signal]),
            this.#operationTimeoutMilliseconds ?? endpoint.timeoutMilliseconds,
        );
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const headers = {
                ...this.authenticationHeaders(credential, "application/json"),
                "content-type": contentType,
            };
            const response = await this.#transport.fetch({
                endpoint,
                origin: this.#endpoint,
                body,
                headers,
                signal: deadline.signal,
            });
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            if (!response.ok) {
                await throwApiError(response);
            }
            return await response.text();
        } catch (cause) {
            if (!signal.aborted) {
                this.#lifetime.signal.throwIfAborted();
            }
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    private readonly authenticationHeaders = (
        credential: string,
        accept: string,
    ): Readonly<Record<string, string>> => ({ accept, authorization: `Bearer ${credential}` });
}

export class MortySessionResources {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;

    constructor(executor: MortyRequestExecutor, computerId: string) {
        this.#executor = executor;
        this.#computerId = computerId;
    }

    readonly updateConfiguration = async (
        target: NativeSessionTarget,
        request: UpdateMortySessionConfigurationRequest,
        signal: AbortSignal,
    ) => {
        const requestId = crypto.randomUUID();
        const result = await this.#executor.post(
            sessionEndpoints.updateConfiguration({ computerId: this.#computerId, target }),
            await sessionConfigureCommandCodec.encode(
                { ...request, kind: "session.configure", requestId, target },
                this.#executor.payloadEncryption,
                signal,
            ),
            signal,
        );
        if (decodeMessageKind(result) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(result, this.#executor.payloadEncryption, signal),
                requestId,
                target,
            );
        }
        const decoded = await sessionConfigUpdatedEventCodec.decode(result, this.#executor.payloadEncryption, signal);
        if (decoded.requestId !== requestId || !sameNativeSession(decoded.target, target)) {
            throw new MortyProtocolError("The Computer returned a response for another request");
        }
        return decoded;
    };

    readonly readConfiguration = async (target: NativeSessionTarget, signal: AbortSignal) => {
        const requestId = crypto.randomUUID();
        const result = await this.#executor.get(
            sessionEndpoints.readConfiguration({ computerId: this.#computerId, target }),
            await sessionConfigReadCommandCodec.encode(
                { kind: "session.config.read", requestId, target },
                this.#executor.payloadEncryption,
                signal,
            ),
            signal,
        );
        if (decodeMessageKind(result) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(result, this.#executor.payloadEncryption, signal),
                requestId,
                target,
            );
        }
        const decoded = await sessionConfigReadResultCodec.decode(result, this.#executor.payloadEncryption, signal);
        if (decoded.requestId !== requestId || !sameNativeSession(decoded.target, target)) {
            throw new MortyProtocolError("The Computer returned a response for another request");
        }
        return decoded;
    };

    readonly rename = async (target: NativeSessionTarget, title: string, signal: AbortSignal) => {
        const requestId = crypto.randomUUID();
        const result = await this.#executor.post(
            sessionEndpoints.rename({ computerId: this.#computerId, target }),
            await sessionRenameCommandCodec.encode(
                { kind: "session.rename", requestId, target, title },
                this.#executor.payloadEncryption,
                signal,
            ),
            signal,
        );
        if (decodeMessageKind(result) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(result, this.#executor.payloadEncryption, signal),
                requestId,
                target,
            );
        }
        const decoded = await sessionRenamedEventCodec.decode(result, this.#executor.payloadEncryption, signal);
        if (decoded.requestId !== requestId || !sameNativeSession(decoded.target, target)) {
            throw new MortyProtocolError("The Computer returned a response for another request");
        }
        return decoded;
    };

    readonly uploadContent = async (
        sessionTarget: NativeSessionTarget,
        input: {
            readonly bytes: Uint8Array;
            readonly contentKey: string;
            readonly kind: "image" | "resource";
            readonly mediaType: string;
            readonly name: string;
            readonly uri: string;
        },
        signal: AbortSignal,
    ): Promise<PromptAttachment> => {
        if (!/^[a-f0-9]{64}$/u.test(input.contentKey)) {
            throw new MortyValidationError("The content key is invalid");
        }
        if (input.bytes.byteLength < 1 || input.bytes.byteLength > CONTENT_WRITE_MAX_BYTES) {
            throw new MortyValidationError("The content size is invalid");
        }
        const attachment = decodePromptAttachment({
            byteLength: input.bytes.byteLength,
            contentKey: input.contentKey,
            kind: input.kind,
            mimeType: input.mediaType,
            name: input.name,
            uri: input.uri,
        });
        const bytes = input.bytes.slice();
        const requestId = crypto.randomUUID();
        const write = await contentWriteCommandCodec.encode(
            {
                kind: "content.write",
                requestId,
                target: sessionTarget,
                byteLength: bytes.byteLength,
                contentKey: input.contentKey,
                contentKind: input.kind,
                mediaType: input.mediaType,
                name: input.name,
            },
            this.#executor.payloadEncryption,
            signal,
        );
        const records: Uint8Array[] = [encodeFileStreamRecord({ kind: "message", encoded: write })];
        for (
            let offset = 0, sequence = 0;
            offset < bytes.byteLength;
            offset += CONTENT_CHUNK_MAX_BYTES, sequence += 1
        ) {
            signal.throwIfAborted();
            const chunk = await contentChunkCodec.encode(
                { requestId, sequence, bytes: bytes.subarray(offset, offset + CONTENT_CHUNK_MAX_BYTES) },
                this.#executor.payloadEncryption,
                signal,
            );
            records.push(encodeFileStreamRecord({ kind: "chunk", encoded: chunk }));
        }
        const commit = await contentCommitCommandCodec.encode(
            { kind: "content.commit", requestId, target: sessionTarget },
            this.#executor.payloadEncryption,
            signal,
        );
        records.push(encodeFileStreamRecord({ kind: "message", encoded: commit }));
        const encodedBytes = records.reduce((total, record) => total + record.byteLength, 0);
        const maximumEncodedBytes =
            2 * (FILE_STREAM_MAX_MESSAGE_BYTES + 5) +
            Math.ceil(bytes.byteLength / CONTENT_CHUNK_MAX_BYTES) * (FILE_STREAM_MAX_CHUNK_BYTES + 5);
        if (
            !Number.isSafeInteger(encodedBytes) ||
            encodedBytes > maximumEncodedBytes ||
            encodedBytes > CONTENT_UPLOAD_MAX_ENCODED_BYTES
        ) {
            throw new MortyProtocolError("The encrypted attachment exceeds its framing limit");
        }
        const wire = new Uint8Array(encodedBytes);
        let offset = 0;
        for (const record of records) {
            wire.set(record, offset);
            offset += record.byteLength;
        }
        const result = await this.#executor.putBinary(
            sessionEndpoints.uploadContent({
                computerId: this.#computerId,
                target: sessionTarget,
                key: input.contentKey,
                uri: input.uri,
            }),
            wire,
            FILE_STREAM_CONTENT_TYPE,
            signal,
        );
        const kind = decodeMessageKind(result);
        if (kind === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(result, this.#executor.payloadEncryption, signal),
                requestId,
                sessionTarget,
            );
        }
        if (kind === "file.failed") {
            const failure = await fileFailedEventCodec.decode(result, this.#executor.payloadEncryption, signal);
            if (failure.requestId !== requestId || !sameNativeSession(failure.target, sessionTarget)) {
                throw new MortyProtocolError("The Computer returned a failure for another upload");
            }
            throw new MortyError(failure.code, failure.message, { cause: failure });
        }
        const available = await contentAvailableEventCodec.decode(result, this.#executor.payloadEncryption, signal);
        if (
            available.requestId !== requestId ||
            !sameNativeSession(available.target, sessionTarget) ||
            available.contentKey !== input.contentKey ||
            available.byteLength !== bytes.byteLength
        ) {
            throw new MortyProtocolError("The Computer returned an invalid uploaded attachment");
        }
        return attachment;
    };

    readonly readFile = async (
        sessionTarget: NativeSessionTarget,
        path: string,
        signal: AbortSignal,
        maximumBytes = 32 * 1024 * 1024,
    ): Promise<{
        readonly bytes: Uint8Array;
        readonly mediaType: string;
        readonly modifiedAt: string;
        readonly name: string;
    }> => {
        if (path.length === 0 || path.length > 4_096) {
            throw new MortyValidationError("The file path is invalid");
        }
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 128 * 1024 * 1024) {
            throw new MortyValidationError("The file size limit is invalid");
        }
        // Reading a file changes nothing, so a read that fails ambiguously is repeated as a new request.
        const requestId = crypto.randomUUID();
        const body = await fileReadCommandCodec.encode(
            { kind: "file.read", maxBytes: maximumBytes, path, requestId, target: sessionTarget },
            this.#executor.payloadEncryption,
            signal,
        );
        return await this.#executor.readFileStream(
            sessionEndpoints.readFile({ computerId: this.#computerId, target: sessionTarget }),
            body,
            { maximumBytes, requestId, target: sessionTarget },
            signal,
        );
    };

    /**
     * Reads the Session's execution. Naming a command also asks for that command's delivery;
     * `command` is present when the request names a command. `lastTurn` reports how the last
     * started command ended when none runs. A missing Session has no interaction snapshot.
     */
    readonly readSessionExecution = async (
        sessionTarget: NativeSessionTarget,
        signal: AbortSignal,
        commandId?: string,
    ): Promise<SessionExecution> => {
        const requestId = crypto.randomUUID();
        const encoded = await this.#executor.get(
            sessionEndpoints.readExecution({
                computerId: this.#computerId,
                target: sessionTarget,
                ...(commandId === undefined ? {} : { commandId }),
            }),
            await nativeSessionCommandCodec.encode(
                {
                    kind: "native.session.request",
                    action: "active-turn",
                    requestId,
                    target: sessionTarget,
                    ...(commandId === undefined ? {} : { deliveryCommandId: commandId }),
                },
                this.#executor.payloadEncryption,
                signal,
            ),
            signal,
        );
        if (decodeMessageKind(encoded) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(encoded, this.#executor.payloadEncryption, signal),
                requestId,
                sessionTarget,
            );
        }
        const result = await nativeSessionResultCodec.decode(encoded, this.#executor.payloadEncryption, signal);
        if (
            result.requestId !== requestId ||
            result.action !== "active-turn" ||
            !sameNativeSession(result.target, sessionTarget)
        ) {
            throw new MortyProtocolError("The service returned an invalid active Turn");
        }
        const { action: _action, kind: _kind, requestId: _requestId, target: _target, ...execution } = result;
        return execution;
    };
}

export class MortyTurnResources {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;

    constructor(executor: MortyRequestExecutor, computerId: string) {
        this.#executor = executor;
        this.#computerId = computerId;
    }

    readonly submit = async (
        sessionTarget: NativeSessionTarget,
        request: SubmitMortyTurnRequest,
        signal: AbortSignal,
    ): Promise<Turn> => {
        const commandId = request.idempotencyKey;
        const requestId = commandId;
        signal.throwIfAborted();
        let encoded: string;
        try {
            encoded = await sessionPromptCommandCodec.encode(
                {
                    kind: "session.prompt",
                    requestId,
                    commandId,
                    target: sessionTarget,
                    prompt: request.content,
                    attachments: request.attachments,
                    disposition: request.disposition ?? "append",
                    sessionConfigurations: request.sessionConfigurations ?? [],
                    ...(request.disposition === "steer" ? { targetCommandId: request.targetCommandId } : {}),
                },
                this.#executor.payloadEncryption,
                signal,
            );
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof ProtocolMessageError) {
                // Encoding validates before transport: this failure cannot have admitted the command.
                throw new MortyValidationError("The message or its attachments are invalid.", { cause });
            }
            throw cause;
        }
        const result = await this.#executor.post(
            sessionEndpoints.submitTurn({ computerId: this.#computerId, target: sessionTarget }),
            encoded,
            signal,
        );
        if (decodeMessageKind(result) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(result, this.#executor.payloadEncryption, signal),
                requestId,
                sessionTarget,
            );
        }
        const accepted = await sessionPromptAcceptedEventCodec.decode(result, this.#executor.payloadEncryption, signal);
        if (accepted.requestId !== requestId || !sameNativeSession(accepted.target, sessionTarget)) {
            throw new MortyProtocolError("The Computer returned an invalid Turn");
        }
        const acceptedAt = new Date().toISOString();
        const state =
            accepted.state === "running"
                ? { kind: "running", startedAt: acceptedAt }
                : accepted.state === "queued"
                  ? { kind: "queued" }
                  : {
                        kind: "indeterminate",
                        reconciliation: { detectedAt: acceptedAt, reason: "dispatch_indeterminate" },
                    };
        const turn = decodeTurn({
            acceptedAt,
            idempotencyKey: commandId,
            turnId: commandId,
            target: sessionTarget,
            request: {
                kind: "prompt",
                content: request.content,
                sessionConfigurations: request.sessionConfigurations ?? [],
            },
            state,
        });
        if (turn === null) {
            throw new MortyProtocolError("The service returned an invalid Turn");
        }
        return turn;
    };

    readonly cancel = async (
        sessionTarget: NativeSessionTarget,
        turnId: string,
        signal: AbortSignal,
    ): Promise<MortyTurnCancellation> => {
        const requestId = crypto.randomUUID();
        const encoded = await this.#executor.post(
            sessionEndpoints.cancelTurn({ computerId: this.#computerId, target: sessionTarget, turnId }),
            await sessionCancelCommandCodec.encode(
                { kind: "session.cancel", requestId, target: sessionTarget, commandId: turnId },
                this.#executor.payloadEncryption,
                signal,
            ),
            signal,
        );
        if (decodeMessageKind(encoded) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(encoded, this.#executor.payloadEncryption, signal),
                requestId,
                sessionTarget,
            );
        }
        const result = await sessionTurnStoppedEventCodec.decode(encoded, this.#executor.payloadEncryption, signal);
        if (
            result.requestId !== requestId ||
            !sameNativeSession(result.target, sessionTarget) ||
            result.commandId !== turnId
        ) {
            throw new MortyProtocolError("The Computer returned an invalid Turn cancellation");
        }
        return this.#answeredFor(turnId, "Turn cancellation", decodeTurnCancellation, {
            turnId: result.commandId,
            stopReason: result.stopReason,
        });
    };

    /** The Relay's answer, decoded by its protocol schema, and checked to be about the Turn the call named. */
    readonly #answeredFor = <Answer extends TurnReference>(
        turnId: string,
        what: string,
        decode: (value: unknown) => Answer,
        value: unknown,
    ): Answer => {
        let answer: Answer;
        try {
            answer = decode(value);
        } catch (cause) {
            throw new MortyProtocolError(`The service returned an invalid ${what}`, { cause });
        }
        if (answer.turnId !== turnId) {
            throw new MortyProtocolError(`The service returned an invalid ${what}`);
        }
        return answer;
    };

    /** Withdraws a queued prompt only when the Computer confirms it did not execute. */
    readonly cancelQueued = async (
        sessionTarget: NativeSessionTarget,
        turnId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const requestId = crypto.randomUUID();
        const encoded = await this.#executor.post(
            sessionEndpoints.cancelQueuedTurn({ computerId: this.#computerId, target: sessionTarget, turnId }),
            await sessionCancelBeforeStartCommandCodec.encode(
                { kind: "session.cancel-before-start", requestId, target: sessionTarget, commandId: turnId },
                this.#executor.payloadEncryption,
                signal,
            ),
            signal,
        );
        if (decodeMessageKind(encoded) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(encoded, this.#executor.payloadEncryption, signal),
                requestId,
                sessionTarget,
            );
        }
        const result = await sessionTurnWithdrawnEventCodec.decode(encoded, this.#executor.payloadEncryption, signal);
        if (
            result.requestId !== requestId ||
            !sameNativeSession(result.target, sessionTarget) ||
            result.commandId !== turnId
        ) {
            throw new MortyProtocolError("The service returned an invalid queued cancellation");
        }
        this.#answeredFor(turnId, "queued cancellation", decodeTurnReference, { turnId: result.commandId });
    };

    readonly steer = async (
        sessionTarget: NativeSessionTarget,
        turnId: string,
        signal: AbortSignal,
    ): Promise<{ readonly turnId: string }> => {
        const requestId = crypto.randomUUID();
        const encoded = await this.#executor.put(
            sessionEndpoints.steerTurn({ computerId: this.#computerId, target: sessionTarget, turnId }),
            await sessionPromptDispositionCommandCodec.encode(
                {
                    kind: "session.prompt.disposition",
                    requestId,
                    target: sessionTarget,
                    commandId: turnId,
                    disposition: SessionPromptDisposition.Steer,
                },
                this.#executor.payloadEncryption,
                signal,
            ),
            signal,
        );
        if (decodeMessageKind(encoded) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(encoded, this.#executor.payloadEncryption, signal),
                requestId,
                sessionTarget,
            );
        }
        const result = await sessionPromptSteeredEventCodec.decode(encoded, this.#executor.payloadEncryption, signal);
        if (
            result.requestId !== requestId ||
            !sameNativeSession(result.target, sessionTarget) ||
            result.commandId !== turnId
        ) {
            throw new MortyProtocolError("The service returned an invalid steered Turn");
        }
        return this.#answeredFor(turnId, "steered Turn", decodeTurnReference, { turnId: result.commandId });
    };
}

export class MortyInteractionResources {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;

    constructor(executor: MortyRequestExecutor, computerId: string) {
        this.#executor = executor;
        this.#computerId = computerId;
    }

    // The Relay serves no interaction read routes: pending interactions come from the Session's lifecycle events and
    // its execution snapshot. Only the response submission crosses the Relay API.
    readonly respond = async (
        sessionTarget: NativeSessionTarget,
        interactionId: string,
        request: MortyInteractionResponseRequest,
        signal: AbortSignal,
    ): Promise<void> => {
        const requestId = crypto.randomUUID();
        const encoded = await this.#executor.post(
            sessionEndpoints.respond({ computerId: this.#computerId, target: sessionTarget, interactionId }),
            request.kind === "permission"
                ? await sessionPermissionRespondCommandCodec.encode(
                      {
                          kind: "session.permission.respond",
                          requestId,
                          target: sessionTarget,
                          interactionId,
                          optionId: request.optionId,
                          outcome: request.outcome,
                      },
                      this.#executor.payloadEncryption,
                      signal,
                  )
                : await sessionElicitationRespondCommandCodec.encode(
                      {
                          kind: "session.elicitation.respond",
                          requestId,
                          target: sessionTarget,
                          interactionId,
                          action: request.action,
                          content: request.content,
                      },
                      this.#executor.payloadEncryption,
                      signal,
                  ),
            signal,
        );
        if (decodeMessageKind(encoded) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(encoded, this.#executor.payloadEncryption, signal),
                requestId,
                sessionTarget,
            );
        }
        const result = await sessionInteractionAnsweredEventCodec.decode(
            encoded,
            this.#executor.payloadEncryption,
            signal,
        );
        if (
            result.requestId !== requestId ||
            !sameNativeSession(result.target, sessionTarget) ||
            result.interactionId !== interactionId
        ) {
            throw new MortyProtocolError("The service returned an invalid Interaction response");
        }
    };
}

export interface MortySessionEventObserver {
    readonly receive: (events: SessionLiveEventBatch) => Promise<boolean>;
    /** Catches up on what the stream did not carry, once the stream is open and before its first events. */
    readonly reconcile: () => Promise<void>;
}

/** One live event stream for a Session. Its owner recovers it: a lost stream fails `completed`. */
export class MortyLiveEventSubscription {
    readonly #controller = new AbortController();
    readonly #executor: MortyRequestExecutor;
    readonly #observer: MortySessionEventObserver;
    readonly #endpoint: MortyEndpointCall;
    readonly #target: NativeSessionTarget;
    #closed = false;
    readonly connected: Promise<void>;
    readonly completed: Promise<void>;

    constructor(
        executor: MortyRequestExecutor,
        endpoint: MortyEndpointCall,
        observer: MortySessionEventObserver,
        signal: AbortSignal,
        target: NativeSessionTarget,
    ) {
        this.#executor = executor;
        this.#observer = observer;
        this.#endpoint = endpoint;
        this.#target = target;
        const abort = (): void => this.#controller.abort(signal.reason);
        if (signal.aborted) {
            abort();
        } else {
            signal.addEventListener("abort", abort, { once: true });
        }
        const connected = Promise.withResolvers<void>();
        this.connected = connected.promise;
        this.completed = this.run(connected.resolve, connected.reject).finally(() =>
            signal.removeEventListener("abort", abort),
        );
    }

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#controller.abort(new Error("The live session event subscription closed"));
    };

    private readonly run = async (
        resolveConnected: () => void,
        rejectConnected: (cause: unknown) => void,
    ): Promise<void> => {
        let connected = false;
        let connection: LiveEventConnection | null = null;
        try {
            const subscriptionId = crypto.randomUUID();
            connection = await this.#executor.openLiveEventStream(
                this.#endpoint,
                await sessionEventsSubscribeCommandCodec.encode(
                    {
                        kind: "session.events.subscribe",
                        subscriptionId,
                        target: this.#target,
                    },
                    this.#executor.payloadEncryption,
                    this.#controller.signal,
                ),
                subscriptionId,
                this.#controller.signal,
            );
            await this.#observer.reconcile();
            connected = true;
            resolveConnected();
            const reader = connection.events.getReader();
            try {
                while (!this.#closed) {
                    const result = await reader.read();
                    if (result.done) {
                        throw new MortyConnectionError("The live session event stream disconnected");
                    }
                    const plaintext = await executeLiveDeliveryOnce(
                        result.value,
                        async (signal) => {
                            const kind = decodeMessageKind(result.value.data);
                            if (kind === "session.close.notice") {
                                return JSON.stringify(
                                    await sessionCloseNoticeEventCodec.decode(
                                        result.value.data,
                                        this.#executor.payloadEncryption,
                                        signal,
                                    ),
                                );
                            }
                            if (kind === "session.event.v2") {
                                return JSON.stringify(
                                    await sessionEventEnvelopeCodec.decode(
                                        result.value.data,
                                        this.#executor.payloadEncryption,
                                        signal,
                                    ),
                                );
                            }
                            throw new MortyProtocolError(
                                "The live Session event stream contains an unexpected message",
                            );
                        },
                        this.#controller.signal,
                    );
                    this.#controller.signal.throwIfAborted();
                    const kind = decodeMessageKind(plaintext);
                    if (kind === "session.close.notice") {
                        const notice = decodeSessionCloseNoticeEvent(plaintext);
                        if (!sameNativeSession(notice.target, this.#target)) {
                            throw new MortyProtocolError("The live Session close notice is invalid");
                        }
                        throw new MortyError(SESSION_CLOSED_ERROR_CODE, notice.reason, { cause: notice });
                    }
                    if (kind !== "session.event.v2") {
                        throw new MortyProtocolError("The live Session event stream contains an unexpected message");
                    }
                    const message = decodeSessionEventEnvelope(plaintext);
                    const events = decodeKnownSessionLiveEventBatch(message.events);
                    if (events.some((event) => !sameNativeSession(event.target, this.#target))) {
                        throw new MortyProtocolError("The live Session event stream contains another Session");
                    }
                    if (events.length === 0) {
                        continue;
                    }
                    if (!(await this.#observer.receive(events))) {
                        this.close();
                    }
                }
            } finally {
                reader.releaseLock();
            }
        } catch (cause) {
            if (this.#closed || this.#controller.signal.aborted) {
                if (!connected) {
                    rejectConnected(new MortyCancellationError({ cause }));
                }
                return;
            }
            const failure = liveStreamFailure(cause);
            if (!connected) {
                rejectConnected(failure);
            }
            throw failure;
        } finally {
            connection?.close();
        }
    };
}

/** Protocol and request failures keep their meaning; a lost connection reports its sanitized causes. */
function liveStreamFailure(cause: unknown): unknown {
    if (
        cause instanceof MortyProtocolError ||
        (cause instanceof MortyApiError && cause.status < 500) ||
        (cause instanceof MortyError &&
            !(cause instanceof MortyConnectionError) &&
            !(cause instanceof MortyTimeoutError) &&
            !(cause instanceof MortyApiError))
    ) {
        return cause;
    }
    const details = connectionCauseMessages(cause);
    return new MortyConnectionError(
        `The live session event stream disconnected${details.length > 0 ? `. Cause: ${details.join(". Caused by: ")}` : ""}`,
        { cause },
    );
}

export class MortyEventResources {
    readonly #executor: MortyRequestExecutor;
    readonly #computerId: string;
    readonly #liveSubscriptions = new Set<MortyLiveEventSubscription>();

    constructor(executor: MortyRequestExecutor, computerId: string) {
        this.#executor = executor;
        this.#computerId = computerId;
    }

    readonly subscribeLive = async (
        sessionTarget: NativeSessionTarget,
        observer: MortySessionEventObserver,
        signal: AbortSignal,
    ): Promise<MortyLiveEventSubscription> => {
        const subscription = new MortyLiveEventSubscription(
            this.#executor,
            sessionEndpoints.liveEvents({ computerId: this.#computerId, target: sessionTarget }),
            observer,
            signal,
            sessionTarget,
        );
        this.#liveSubscriptions.add(subscription);
        void subscription.completed.finally(() => this.#liveSubscriptions.delete(subscription)).catch(() => undefined);
        await subscription.connected;
        return subscription;
    };

    readonly list = async (
        sessionTarget: NativeSessionTarget,
        page: MortyPageRequest,
        signal: AbortSignal,
    ): Promise<SessionEventLogPage> => {
        const requestId = crypto.randomUUID();
        const encoded = await this.#executor.get(
            sessionEndpoints.listEvents({
                computerId: this.#computerId,
                target: sessionTarget,
                limit: page.limit,
                cursor: page.cursor,
            }),
            await sessionHistoryPageLoadCodec.encode(
                {
                    kind: "session.live-history.v2.page.load",
                    requestId,
                    target: sessionTarget,
                    eventLimit: page.limit,
                    cursor: page.cursor.length === 0 ? null : page.cursor,
                },
                this.#executor.payloadEncryption,
                signal,
            ),
            signal,
        );
        if (decodeMessageKind(encoded) === "session.operation.failed") {
            return throwNativeFailure(
                await sessionOperationFailedEventCodec.decode(encoded, this.#executor.payloadEncryption, signal),
                requestId,
                sessionTarget,
            );
        }
        const result = await sessionHistoryPageLoadedCodec.decode(encoded, this.#executor.payloadEncryption, signal);
        if (result.requestId !== requestId || !sameNativeSession(result.target, sessionTarget)) {
            throw new MortyProtocolError("The Computer returned a response for another request");
        }
        return decodeKnownSessionEventLogPage(result.events.events);
    };

    readonly close = (): void => {
        for (const subscription of this.#liveSubscriptions) {
            subscription.close();
        }
        this.#liveSubscriptions.clear();
    };
}

export class MortyClient {
    readonly #executor: MortyRequestExecutor;
    readonly #onClose: (() => void) | undefined;
    #lifecycle: "open" | "closed" = "open";
    readonly events: MortyEventResources;
    readonly interactions: MortyInteractionResources;
    readonly sessions: MortySessionResources;
    readonly turns: MortyTurnResources;

    constructor(options: MortyClientOptions) {
        if (options.encryption.access.computerId !== options.computerId) {
            throw new MortyValidationError("Encrypted access does not match the selected Computer");
        }
        options.transport.configureEncryption(options.encryption.access);
        const executor = new MortyRequestExecutor(options, options.transport);
        this.#executor = executor;
        this.#onClose = options.onClose;
        this.events = new MortyEventResources(executor, options.computerId);
        this.interactions = new MortyInteractionResources(executor, options.computerId);
        this.sessions = new MortySessionResources(executor, options.computerId);
        this.turns = new MortyTurnResources(executor, options.computerId);
    }

    readonly close = (): void => {
        if (this.#lifecycle === "closed") {
            return;
        }
        this.#lifecycle = "closed";
        this.events.close();
        this.#executor.close();
        this.#onClose?.();
    };
}
