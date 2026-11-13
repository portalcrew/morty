import {
    decodeContentChunkFrame,
    decodeSessionCloseNoticeEvent,
    MORTY_API_PREFIX,
    SESSION_CLOSED_ERROR_CODE,
} from "@morty-build/client/protocol";
import {
    CANCEL_KIND,
    ERROR_KIND,
    EVENT_SUBSCRIBE_KIND,
    EVENT_UNSUBSCRIBE_KIND,
    FORBIDDEN_HEADERS,
    FRAME_IDENTIFIER_PATTERN,
    MAX_BODY_BYTES,
    MAX_HEADER_NAME_LENGTH,
    MAX_HEADER_VALUE_LENGTH,
    MAX_HEADERS,
    REQUEST_KIND,
    REQUEST_METHODS,
    RESPONSE_KIND,
} from "../../../../contracts/agent-api/transport-frames.ts";
import { type HttpError, toHttpError } from "../../../../contracts/http-error.ts";
import type { WebSocketHttpDispatch } from "../../../../contracts/websocket-http-dispatch.ts";
import { diagnosticText, serializeDiagnosticError } from "../../../../infra/log-diagnostics.ts";
import { logger } from "../../../../infra/logger.ts";

const MAX_PENDING_BINARY_BYTES = MAX_BODY_BYTES;
const MAX_PENDING_BINARY_REQUESTS = 16;
const BINARY_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const IDLE_TIMEOUT_MILLISECONDS = 60_000;
const MAX_SUBSCRIPTION_DIAGNOSTICS = 8;

type SubscriptionEnd =
    | { readonly kind: "error"; readonly error: unknown }
    | { readonly kind: "close"; readonly code: number; readonly reason: string; readonly wasClean: boolean };
type WebSocketTransportErrorCode =
    | "invalid_headers"
    | "invalid_message"
    | "invalid_method"
    | "invalid_target"
    | "request_capacity_exceeded"
    | "request_timeout"
    | "request_too_large"
    | "response_too_large"
    | "streaming_response_unsupported";

const TRANSPORT_ERRORS: Readonly<
    Record<WebSocketTransportErrorCode, { readonly message: string; readonly status: number }>
> = {
    invalid_headers: { message: "The WebSocket transport headers are invalid", status: 400 },
    invalid_message: { message: "The WebSocket transport message is invalid", status: 400 },
    invalid_method: { message: "The WebSocket transport method is invalid", status: 400 },
    invalid_target: { message: "The WebSocket transport target is invalid", status: 400 },
    request_capacity_exceeded: { message: "The WebSocket transport has too many pending uploads", status: 429 },
    request_timeout: { message: "The WebSocket transport upload timed out", status: 408 },
    request_too_large: { message: "The WebSocket transport request is too large", status: 413 },
    response_too_large: { message: "The WebSocket transport response is too large", status: 502 },
    streaming_response_unsupported: {
        message: "The WebSocket transport does not support streaming responses",
        status: 501,
    },
};

class WebSocketTransportError extends Error implements HttpError {
    readonly #code: WebSocketTransportErrorCode;
    readonly #status: number;

    constructor(code: WebSocketTransportErrorCode) {
        const error = TRANSPORT_ERRORS[code];
        super(error.message);
        this.name = "WebSocketTransportError";
        this.#code = code;
        this.#status = error.status;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.#code, message: this.message } },
        status: this.#status,
    });
}

function transportError(code: WebSocketTransportErrorCode): WebSocketTransportError {
    return new WebSocketTransportError(code);
}

/** Bounds buffering on this connection while the application admits each upload. */
class ConnectionUploadBudget {
    #bytes = 0;
    #requests = 0;

    readonly reserve = (bytes: number): void => {
        if (this.#bytes + bytes > MAX_PENDING_BINARY_BYTES || this.#requests >= MAX_PENDING_BINARY_REQUESTS) {
            throw transportError("request_capacity_exceeded");
        }
        this.#bytes += bytes;
        this.#requests += 1;
    };

    readonly release = (bytes: number): void => {
        this.#bytes -= bytes;
        this.#requests -= 1;
    };
}

class PendingBinaryUpload {
    readonly chunks: Uint8Array[] = [];
    receivedBytes = 0;
    sequence = 0;
    readonly #ready = Promise.withResolvers<boolean>();
    readonly authorization = this.#ready.promise;
    readonly #controller = new AbortController();
    readonly #timeout: ReturnType<typeof setTimeout>;
    #state: "pending" | "authorized" | "closed" = "pending";

    readonly byteLength: number;
    readonly message: Readonly<Record<string, unknown>>;
    readonly #connectionBudget: ConnectionUploadBudget;
    readonly #onFailure: (cause: unknown) => Promise<void>;

    constructor(
        byteLength: number,
        message: Readonly<Record<string, unknown>>,
        connectionBudget: ConnectionUploadBudget,
        onFailure: (cause: unknown) => Promise<void>,
    ) {
        connectionBudget.reserve(byteLength);
        this.byteLength = byteLength;
        this.message = message;
        this.#connectionBudget = connectionBudget;
        this.#onFailure = onFailure;
        this.#timeout = setTimeout(() => {
            void this.fail(transportError("request_timeout"));
        }, BINARY_REQUEST_TIMEOUT_MILLISECONDS);
    }

    readonly authorize = async (request: Request, dispatch: WebSocketHttpDispatch): Promise<void> => {
        try {
            const response = await dispatch({
                kind: "upload-admission",
                request: new Request(request, { signal: this.#controller.signal }),
                byteLength: this.byteLength,
            });
            if (this.#controller.signal.aborted) {
                return;
            }
            if (!response.ok) {
                await this.fail(response);
                return;
            }
            this.#state = "authorized";
            this.#ready.resolve(true);
        } catch (cause) {
            if (!this.#controller.signal.aborted) {
                await this.fail(cause);
            }
        }
    };

    readonly close = (): void => {
        if (this.#state === "closed") {
            return;
        }
        this.#state = "closed";
        clearTimeout(this.#timeout);
        this.#connectionBudget.release(this.byteLength);
        this.#controller.abort();
        this.#ready.resolve(false);
    };

    private readonly fail = async (cause: unknown): Promise<void> => {
        this.close();
        await this.#onFailure(cause);
    };
}

class PendingRequest {
    #state:
        | { readonly kind: "uncancellable" }
        | {
              readonly kind: "cancellable";
              readonly controller: AbortController;
              readonly timeout: ReturnType<typeof setTimeout>;
          } = { kind: "uncancellable" };
    readonly #requestId: string;
    readonly #connectionSignal: AbortSignal;
    readonly #requests: Map<string, AbortController>;

    constructor(requestId: string, connectionSignal: AbortSignal, requests: Map<string, AbortController>) {
        this.#requestId = requestId;
        this.#connectionSignal = connectionSignal;
        this.#requests = requests;
    }

    readonly enableCancellation = (): AbortSignal => {
        if (this.#state.kind === "uncancellable") {
            if (this.#requests.has(this.#requestId)) {
                throw transportError("invalid_message");
            }
            if (this.#requests.size >= 64) {
                throw transportError("request_capacity_exceeded");
            }
            const controller = new AbortController();
            this.#state = {
                kind: "cancellable",
                controller,
                timeout: setTimeout(() => controller.abort(transportError("request_timeout")), 120_000),
            };
            this.#requests.set(this.#requestId, controller);
        }
        return AbortSignal.any([this.#connectionSignal, this.#state.controller.signal]);
    };

    readonly throwIfAborted = (): void => {
        if (this.#state.kind === "cancellable") {
            this.#state.controller.signal.throwIfAborted();
        }
    };

    readonly cancelled = (): boolean =>
        this.#state.kind === "cancellable" &&
        this.#state.controller.signal.aborted &&
        !(this.#state.controller.signal.reason instanceof WebSocketTransportError);

    readonly failure = (cause: unknown): unknown =>
        this.#state.kind === "cancellable" && this.#state.controller.signal.aborted
            ? this.#state.controller.signal.reason
            : cause;

    readonly release = (): void => {
        if (this.#state.kind === "cancellable") {
            clearTimeout(this.#state.timeout);
            this.#requests.delete(this.#requestId);
        }
    };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw transportError("invalid_message");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function string(value: Readonly<Record<string, unknown>>, field: string, maximum: number): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length > maximum) {
        throw transportError("invalid_message");
    }
    return candidate;
}

function requestBody(value: Readonly<Record<string, unknown>>): string {
    const body = string(value, "body", MAX_BODY_BYTES);
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
        throw transportError("request_too_large");
    }
    return body;
}

function headers(value: unknown): Headers {
    if (!Array.isArray(value) || value.length > MAX_HEADERS) {
        throw transportError("invalid_headers");
    }
    const decoded = new Headers();
    for (const entry of value) {
        if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string" ||
            typeof entry[1] !== "string" ||
            entry[0].length > MAX_HEADER_NAME_LENGTH ||
            entry[1].length > MAX_HEADER_VALUE_LENGTH
        ) {
            throw transportError("invalid_headers");
        }
        const name = entry[0].toLowerCase();
        if (
            FORBIDDEN_HEADERS.has(name) ||
            name.startsWith("cf-") ||
            name.startsWith("sec-websocket-") ||
            name.startsWith("x-forwarded-")
        ) {
            throw transportError("invalid_headers");
        }
        decoded.append(entry[0], entry[1]);
    }
    return decoded;
}

function requestIdFromMessage(value: Readonly<Record<string, unknown>>): string {
    if (string(value, "kind", 32) !== REQUEST_KIND) {
        throw transportError("invalid_message");
    }
    const requestId = string(value, "requestId", 128);
    if (!FRAME_IDENTIFIER_PATTERN.test(requestId)) {
        throw transportError("invalid_message");
    }
    return requestId;
}

function requestFromMessage(
    value: Readonly<Record<string, unknown>>,
    requestId: string,
    origin: string,
    browserOrigin: string | null,
    signal: AbortSignal,
    binaryBody?: Uint8Array,
): { readonly request: Request; readonly requestId: string } {
    const path = string(value, "path", 8_192);
    if (!path.startsWith(`${MORTY_API_PREFIX}/`) || path.startsWith(`${MORTY_API_PREFIX}/v1/transport`)) {
        throw transportError("invalid_target");
    }
    const endpoint = new URL(path, origin);
    if (endpoint.origin !== origin || `${endpoint.pathname}${endpoint.search}` !== path || endpoint.hash.length > 0) {
        throw transportError("invalid_target");
    }
    const method = string(value, "method", 16);
    if (!REQUEST_METHODS.some((allowed) => allowed === method)) {
        throw transportError("invalid_method");
    }
    const body = binaryBody ?? requestBody(value);
    if (method === "GET" && body.length > 0) {
        throw transportError("invalid_message");
    }
    const requestHeaders = headers(value["headers"]);
    if (browserOrigin !== null) {
        requestHeaders.set("origin", browserOrigin);
    }
    return {
        request: new Request(endpoint, {
            body: body.length === 0 || method === "GET" ? null : typeof body === "string" ? body : body.slice().buffer,
            headers: requestHeaders,
            method,
            signal,
        }),
        requestId,
    };
}

function responseHeaders(response: Response): readonly (readonly [string, string])[] {
    return Array.from(response.headers.entries()).filter(
        ([name]) => !FORBIDDEN_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith("sec-websocket-"),
    );
}

export function acceptWebSocketHttpTransport({
    request,
    dispatch,
}: {
    readonly request: Request;
    readonly dispatch: WebSocketHttpDispatch;
}): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json(
            { error: { code: "websocket_upgrade_required", message: "A WebSocket upgrade is required" } },
            { status: 426 },
        );
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const controller = new AbortController();
    const subscriptions = new Map<
        string,
        | { readonly kind: "pending"; readonly controller: AbortController }
        | { readonly kind: "open"; readonly socket: WebSocket }
    >();
    const connectionUploads = new ConnectionUploadBudget();
    const binaryRequests = new Map<string, PendingBinaryUpload>();
    const requests = new Map<string, AbortController>();
    const browserOrigin = request.headers.get("origin");
    let subscriptionDiagnosticCount = 0;
    let lastActivityAt = Date.now();
    let idleTimeout: ReturnType<typeof setTimeout>;
    const touch = (): void => {
        clearTimeout(idleTimeout);
        if (server.readyState !== WebSocket.OPEN) {
            return;
        }
        lastActivityAt = Date.now();
        idleTimeout = setTimeout(checkIdleDeadline, IDLE_TIMEOUT_MILLISECONDS);
    };
    const checkIdleDeadline = (): void => {
        const remaining = IDLE_TIMEOUT_MILLISECONDS - (Date.now() - lastActivityAt);
        if (remaining > 0) {
            idleTimeout = setTimeout(checkIdleDeadline, remaining);
        } else {
            controller.abort(new Error("WebSocket transport became inactive"));
            server.close(1001, "WebSocket transport idle timeout");
            release();
        }
    };
    const releaseBinaryRequest = (requestId: string) => {
        const upload = binaryRequests.get(requestId);
        if (upload === undefined) {
            return undefined;
        }
        binaryRequests.delete(requestId);
        upload.close();
        return upload;
    };
    const releaseAllBinaryRequests = (): void => {
        for (const requestId of binaryRequests.keys()) {
            releaseBinaryRequest(requestId);
        }
    };
    const release = () => {
        controller.abort(new Error("WebSocket transport closed"));
        clearTimeout(idleTimeout);
        for (const subscription of subscriptions.values()) {
            if (subscription.kind === "pending") {
                subscription.controller.abort(new Error("WebSocket transport closed"));
            } else if (
                subscription.socket.readyState === WebSocket.OPEN ||
                subscription.socket.readyState === WebSocket.CONNECTING
            ) {
                subscription.socket.close(1000, "WebSocket transport closed");
            }
        }
        subscriptions.clear();
        releaseAllBinaryRequests();
        for (const pending of requests.values()) {
            pending.abort(new DOMException("WebSocket transport closed", "AbortError"));
        }
        requests.clear();
    };
    const receive = (data: string | ArrayBuffer) => {
        const event = { data };
        touch();
        void (async () => {
            let requestId = "unknown";
            let operation: PendingRequest | null = null;
            try {
                let decoded: unknown;
                let binaryBody: Uint8Array | undefined;
                if (typeof event.data === "string") {
                    decoded = JSON.parse(event.data);
                } else {
                    const arrayBuffer =
                        typeof event.data === "object" && event.data !== null
                            ? Reflect.get(event.data, "arrayBuffer")
                            : undefined;
                    const binary =
                        typeof arrayBuffer === "function"
                            ? await Reflect.apply(arrayBuffer, event.data, [])
                            : event.data;
                    const chunk = decodeContentChunkFrame(binary);
                    requestId = chunk.requestId;
                    const upload = binaryRequests.get(chunk.requestId);
                    if (upload === undefined || chunk.sequence !== upload.sequence) {
                        releaseBinaryRequest(chunk.requestId);
                        throw transportError("invalid_message");
                    }
                    upload.sequence += 1;
                    upload.receivedBytes += chunk.bytes.byteLength;
                    if (upload.receivedBytes > upload.byteLength) {
                        releaseBinaryRequest(chunk.requestId);
                        throw transportError("request_too_large");
                    }
                    upload.chunks.push(chunk.bytes);
                    if (upload.receivedBytes < upload.byteLength) {
                        return;
                    }
                    if (!(await upload.authorization) || binaryRequests.get(chunk.requestId) !== upload) {
                        return;
                    }
                    const completed = releaseBinaryRequest(chunk.requestId);
                    if (completed === undefined) {
                        throw transportError("invalid_message");
                    }
                    binaryBody = new Uint8Array(completed.byteLength);
                    let offset = 0;
                    for (const bytes of completed.chunks) {
                        binaryBody.set(bytes, offset);
                        offset += bytes.byteLength;
                    }
                    decoded = completed.message;
                }
                const message = record(decoded);
                const kind = string(message, "kind", 32);
                if (kind === "ping" && Object.keys(message).length === 1) {
                    server.send('{"kind":"pong"}');
                    return;
                }
                if (kind === CANCEL_KIND) {
                    const cancelledId = string(message, "requestId", 128);
                    requests.get(cancelledId)?.abort(new DOMException("Request cancelled", "AbortError"));
                    releaseBinaryRequest(cancelledId);
                    return;
                }
                if (kind === EVENT_UNSUBSCRIBE_KIND) {
                    const subscriptionId = string(message, "subscriptionId", 128);
                    const subscription = subscriptions.get(subscriptionId);
                    if (subscription?.kind === "pending") {
                        subscription.controller.abort(new Error("Session event subscription closed"));
                    } else if (
                        subscription?.kind === "open" &&
                        (subscription.socket.readyState === WebSocket.OPEN ||
                            subscription.socket.readyState === WebSocket.CONNECTING)
                    ) {
                        subscription.socket.close(1000, "Session event subscription closed");
                    }
                    subscriptions.delete(subscriptionId);
                    return;
                }
                if (kind === EVENT_SUBSCRIBE_KIND) {
                    const subscriptionId = string(message, "subscriptionId", 128);
                    if (!FRAME_IDENTIFIER_PATTERN.test(subscriptionId) || subscriptions.has(subscriptionId)) {
                        throw transportError("invalid_message");
                    }
                    requestId = subscriptionId;
                    const subscriptionController = new AbortController();
                    const converted = requestFromMessage(
                        {
                            body: "",
                            headers: message["headers"],
                            kind: REQUEST_KIND,
                            method: "GET",
                            path: message["path"],
                            requestId: subscriptionId,
                        },
                        subscriptionId,
                        new URL(request.url).origin,
                        browserOrigin,
                        subscriptionController.signal,
                    );
                    subscriptions.set(subscriptionId, { controller: subscriptionController, kind: "pending" });
                    const subscriptionHeaders = new Headers(converted.request.headers);
                    subscriptionHeaders.set("Upgrade", "websocket");
                    const response = await dispatch({
                        kind: "request",
                        request: new Request(converted.request, { headers: subscriptionHeaders }),
                        enableCancellation: () => subscriptionController.signal,
                    }).catch((cause: unknown) => {
                        const pending = subscriptions.get(subscriptionId);
                        if (pending?.kind === "pending" && pending.controller === subscriptionController) {
                            subscriptions.delete(subscriptionId);
                        }
                        subscriptionController.abort(cause);
                        throw cause;
                    });
                    const subscription = response.webSocket;
                    if (subscription === null) {
                        subscriptions.delete(subscriptionId);
                        const failure = await response.json().catch(() => null);
                        const error =
                            typeof failure === "object" && failure !== null && "error" in failure
                                ? record(Reflect.get(failure, "error"))
                                : {};
                        server.send(
                            JSON.stringify({
                                code: typeof error["code"] === "string" ? error["code"] : "session_unavailable",
                                kind: "session.events.error",
                                message:
                                    typeof error["message"] === "string"
                                        ? error["message"]
                                        : "The Session event subscription is unavailable",
                                status: response.status >= 400 ? response.status : 502,
                                subscriptionId,
                            }),
                        );
                        return;
                    }
                    if (subscriptions.get(subscriptionId)?.kind !== "pending") {
                        subscription.close(1000, "Session event subscription closed");
                        return;
                    }
                    subscriptions.set(subscriptionId, { kind: "open", socket: subscription });
                    let nextSequenceId = 1;
                    const openedAt = Date.now();
                    let lastMessageAt: number | null = null;
                    const finish = (end: SubscriptionEnd): void => {
                        subscription.close(1000, "Session event subscription closed");
                        const current = subscriptions.get(subscriptionId);
                        if (
                            current?.kind === "open" &&
                            current.socket === subscription &&
                            subscriptions.delete(subscriptionId) &&
                            server.readyState === WebSocket.OPEN
                        ) {
                            const unexpected =
                                end.kind === "error" || !end.wasClean || (end.code !== 1000 && end.code !== 1001);
                            // A flapping subscription must not produce an unbounded log stream.
                            // Normal unsubscribe, browser close, and clean upstream close remain quiet.
                            if (unexpected && subscriptionDiagnosticCount < MAX_SUBSCRIPTION_DIAGNOSTICS) {
                                subscriptionDiagnosticCount += 1;
                                const now = Date.now();
                                logger.warn(
                                    {
                                        event: "session_event_subscription_disconnected",
                                        source: end.kind === "error" ? "upstream_error" : "upstream_close",
                                        cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
                                        path: new URL(converted.request.url).pathname,
                                        subscriptionId,
                                        elapsedMilliseconds: Math.max(0, now - openedAt),
                                        lastMessageAgeMilliseconds:
                                            lastMessageAt === null ? null : Math.max(0, now - lastMessageAt),
                                        messageCount: nextSequenceId - 1,
                                        ...(end.kind === "error"
                                            ? { error: serializeDiagnosticError(end.error) }
                                            : {
                                                  closeCode: end.code,
                                                  closeReason: diagnosticText(end.reason, 256),
                                                  wasClean: end.wasClean,
                                              }),
                                    },
                                    "Session event subscription disconnected",
                                );
                            }
                            server.send(JSON.stringify({ kind: "session.events.end", subscriptionId }));
                        }
                    };
                    subscription.addEventListener("message", (subscriptionEvent) => {
                        if (
                            typeof subscriptionEvent.data === "string" &&
                            server.readyState === WebSocket.OPEN &&
                            subscriptions.get(subscriptionId)?.kind === "open"
                        ) {
                            // Live event batches are arrays. A close notice ends only this subscription.
                            if (subscriptionEvent.data.startsWith("{")) {
                                const notice = decodeSessionCloseNoticeEvent(subscriptionEvent.data);
                                subscriptions.delete(subscriptionId);
                                server.send(
                                    JSON.stringify({
                                        kind: "session.events.error",
                                        code: SESSION_CLOSED_ERROR_CODE,
                                        status: 409,
                                        message: notice.reason,
                                        subscriptionId,
                                    }),
                                );
                                subscription.close(1000, "Session closed");
                                return;
                            }
                            lastMessageAt = Date.now();
                            server.send(
                                JSON.stringify({
                                    data: subscriptionEvent.data,
                                    eventId: "",
                                    kind: "session.events.event",
                                    seqId: nextSequenceId,
                                    subscriptionId,
                                }),
                            );
                            nextSequenceId += 1;
                            touch();
                        }
                    });
                    subscription.addEventListener(
                        "close",
                        (event) =>
                            finish({ kind: "close", code: event.code, reason: event.reason, wasClean: event.wasClean }),
                        { once: true },
                    );
                    subscription.addEventListener(
                        "error",
                        (event) => finish({ kind: "error", error: "error" in event ? event.error : undefined }),
                        { once: true },
                    );
                    subscription.accept();
                    server.send(
                        JSON.stringify({
                            kind: "session.events.ready",
                            subscriptionId,
                        }),
                    );
                    touch();
                    return;
                }
                const bodyByteLength = message["bodyByteLength"];
                if (binaryBody === undefined && bodyByteLength !== undefined) {
                    requestId = requestIdFromMessage(message);
                    if (
                        !Number.isSafeInteger(bodyByteLength) ||
                        typeof bodyByteLength !== "number" ||
                        bodyByteLength < 1 ||
                        bodyByteLength > MAX_BODY_BYTES ||
                        requestBody(message).length !== 0 ||
                        binaryRequests.has(requestId)
                    ) {
                        throw transportError("invalid_message");
                    }
                    const declaration = requestFromMessage(
                        message,
                        requestId,
                        new URL(request.url).origin,
                        browserOrigin,
                        controller.signal,
                        new Uint8Array(0),
                    );
                    if (declaration.request.method === "GET") {
                        throw transportError("invalid_message");
                    }
                    const upload = new PendingBinaryUpload(
                        bodyByteLength,
                        message,
                        connectionUploads,
                        async (cause) => {
                            if (binaryRequests.get(requestId) !== upload) {
                                return;
                            }
                            releaseBinaryRequest(requestId);
                            if (cause instanceof Response) {
                                const body = await cause.text();
                                if (server.readyState === WebSocket.OPEN) {
                                    server.send(
                                        JSON.stringify({
                                            body,
                                            headers: responseHeaders(cause),
                                            kind: RESPONSE_KIND,
                                            requestId,
                                            status: cause.status,
                                        }),
                                    );
                                }
                            } else if (server.readyState === WebSocket.OPEN) {
                                const error = toHttpError(cause);
                                server.send(
                                    JSON.stringify({
                                        code: error.body.error.code,
                                        kind: ERROR_KIND,
                                        message: error.body.error.message,
                                        requestId,
                                        status: error.status,
                                    }),
                                );
                            }
                        },
                    );
                    binaryRequests.set(requestId, upload);
                    void upload.authorize(declaration.request, dispatch);
                    return;
                }
                requestId = requestIdFromMessage(message);
                const converted = requestFromMessage(
                    message,
                    requestId,
                    new URL(request.url).origin,
                    browserOrigin,
                    controller.signal,
                    binaryBody,
                );
                requestId = converted.requestId;
                operation = new PendingRequest(requestId, controller.signal, requests);
                const response = await dispatch({
                    kind: "request",
                    request: converted.request,
                    enableCancellation: operation.enableCancellation,
                });
                operation.throwIfAborted();
                const mediaType = response.headers.get("content-type") ?? "";
                if (mediaType.startsWith("text/event-stream")) {
                    throw transportError("streaming_response_unsupported");
                }
                const body = await response.text();
                if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
                    throw transportError("response_too_large");
                }
                server.send(
                    JSON.stringify({
                        body,
                        headers: responseHeaders(response),
                        kind: RESPONSE_KIND,
                        requestId,
                        status: response.status,
                    }),
                );
                touch();
            } catch (cause) {
                if (controller.signal.aborted || server.readyState !== WebSocket.OPEN || operation?.cancelled()) {
                    return;
                }
                logger.error({ err: cause, requestId }, "Morty WebSocket transport request failed");
                const httpError = toHttpError(operation === null ? cause : operation.failure(cause));
                server.send(
                    JSON.stringify({
                        code: httpError.body.error.code,
                        kind: ERROR_KIND,
                        message: httpError.body.error.message,
                        requestId,
                        status: httpError.status,
                    }),
                );
            } finally {
                operation?.release();
            }
        })();
    };
    server.accept();
    server.addEventListener("message", (event) => receive(event.data));
    server.addEventListener(
        "close",
        () => {
            release();
            server.close(1000, "WebSocket transport closed");
        },
        { once: true },
    );
    server.addEventListener(
        "error",
        () => {
            release();
            server.close(1011, "WebSocket transport failed");
        },
        { once: true },
    );
    touch();
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
