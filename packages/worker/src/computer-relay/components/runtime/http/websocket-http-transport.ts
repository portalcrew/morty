import {
    CHANGES_ERROR_KIND,
    CHANGES_FOLLOW_KIND,
    CHANGES_READY_KIND,
    CONTENT_UPLOAD_MAX_ENCODED_BYTES,
    decodeContentChunkFrame,
    FILE_STREAM_CONTENT_TYPE,
    MORTY_API_PREFIX,
    SESSION_SUBSCRIPTION_REPLACED,
    type SessionEventsSubscribeCommandRouting,
    sessionEventsSubscribeCommandCodec,
} from "@portalcrew/morty-client/protocol";
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
import type { ChangeFollow, FollowChanges } from "../../../../contracts/relay-changes.ts";
import type {
    RestoreSessionEvents,
    SessionViewerIdentity,
    SubscribeSessionEvents,
} from "../../../../contracts/session-event-subscription.ts";
import { WebSocketDispatchError, type WebSocketHttpDispatch } from "../../../../contracts/websocket-http-dispatch.ts";
import { readBearerToken } from "../../../../http/request-headers.ts";
import { diagnosticText } from "../../../../infra/log-diagnostics.ts";
import { logger } from "../../../../infra/logger.ts";
import { WebSocketUploadCapacity } from "../service/websocket-upload-capacity.ts";

// An upload keeps its buffer while chunks keep arriving, and no longer than the client waits for the whole request.
const BINARY_CHUNK_TIMEOUT_MILLISECONDS = 30_000;
const BINARY_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const MAX_SUBSCRIPTION_DIAGNOSTICS = 8;
// A connection's open subscriptions are saved with it, which bounds them by the attachment size.
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 16;
// Requests from a browser are dispatched inside the Relay, where only their path routes them.
const RELAY_INTERNAL_ORIGIN = "https://relay.internal";

export interface BrowserTransportConnection {
    readonly socket: WebSocket;
    readonly computerId: string;
    readonly subscriptions: readonly SessionViewerIdentity[];
    readonly saveSubscriptions: (subscriptions: readonly SessionViewerIdentity[]) => void;
    readonly saveFollow: (follow: ChangeFollow | null) => Promise<void>;
}

export interface BrowserTransportPorts {
    readonly dispatch: WebSocketHttpDispatch;
    readonly subscribe: SubscribeSessionEvents;
    readonly restore: RestoreSessionEvents;
    readonly follow: FollowChanges;
}

export interface BrowserTransport {
    readonly receive: (data: string | ArrayBuffer) => Promise<void>;
    readonly release: () => void;
}

type WebSocketTransportErrorCode =
    | "invalid_headers"
    | "invalid_message"
    | "invalid_method"
    | "invalid_target"
    | "request_capacity_exceeded"
    | "request_timeout"
    | "request_too_large"
    | "response_too_large"
    | typeof SESSION_SUBSCRIPTION_REPLACED
    | "session_unavailable"
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
    [SESSION_SUBSCRIPTION_REPLACED]: {
        message: "The Computer reconnected. Subscribe to the Session again.",
        status: 409,
    },
    session_unavailable: { message: "The Session event subscription is unavailable", status: 502 },
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

function isEncryptedContentUpload(request: Request): boolean {
    const path = new URL(request.url).pathname;
    return (
        request.method === "PUT" &&
        request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === FILE_STREAM_CONTENT_TYPE &&
        new RegExp(
            `^${MORTY_API_PREFIX}/v1/computers/[^/]+/harnesses/[^/]+/sessions/[^/]+/content/[a-f0-9]{64}$`,
            "u",
        ).test(path)
    );
}

class PendingBinaryUpload {
    readonly chunks: Uint8Array[] = [];
    receivedBytes = 0;
    sequence = 0;
    readonly #ready = Promise.withResolvers<boolean>();
    readonly authorization = this.#ready.promise;
    readonly #controller = new AbortController();
    readonly #expiresAt = Date.now() + BINARY_REQUEST_TIMEOUT_MILLISECONDS;
    #timeout: ReturnType<typeof setTimeout> | undefined;
    #closed = false;

    readonly byteLength: number;
    readonly message: Readonly<Record<string, unknown>>;
    readonly #connectionBudget: WebSocketUploadCapacity;
    readonly #encryptedUpload: boolean;
    readonly #onFailure: (cause: unknown) => Promise<void>;

    constructor(
        byteLength: number,
        message: Readonly<Record<string, unknown>>,
        connectionBudget: WebSocketUploadCapacity,
        encryptedUpload: boolean,
        onFailure: (cause: unknown) => Promise<void>,
    ) {
        connectionBudget.reserve(byteLength, encryptedUpload);
        this.byteLength = byteLength;
        this.message = message;
        this.#connectionBudget = connectionBudget;
        this.#encryptedUpload = encryptedUpload;
        this.#onFailure = onFailure;
        this.progressed();
    }

    readonly progressed = (): void => {
        if (this.#closed) {
            return;
        }
        clearTimeout(this.#timeout);
        this.#timeout = setTimeout(
            () => {
                void this.fail(transportError("request_timeout"));
            },
            Math.min(BINARY_CHUNK_TIMEOUT_MILLISECONDS, this.#expiresAt - Date.now()),
        );
    };

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
            this.#ready.resolve(true);
        } catch (cause) {
            if (!this.#controller.signal.aborted) {
                await this.fail(cause);
            }
        }
    };

    readonly close = (): void => {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        clearTimeout(this.#timeout);
        this.#connectionBudget.release(this.byteLength, this.#encryptedUpload);
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

function framePath(value: Readonly<Record<string, unknown>>, origin: string): URL {
    const path = string(value, "path", 8_192);
    if (!path.startsWith(`${MORTY_API_PREFIX}/`) || path.startsWith(`${MORTY_API_PREFIX}/v1/transport`)) {
        throw transportError("invalid_target");
    }
    const endpoint = new URL(path, origin);
    if (endpoint.origin !== origin || `${endpoint.pathname}${endpoint.search}` !== path || endpoint.hash.length > 0) {
        throw transportError("invalid_target");
    }
    return endpoint;
}

function subscriptionAddress(endpoint: URL): {
    readonly computerId: string;
    readonly harness: string;
    readonly sessionId: string;
} {
    const prefix = `${MORTY_API_PREFIX}/v1/computers/`;
    let parts: string[];
    try {
        parts = endpoint.pathname.startsWith(prefix)
            ? endpoint.pathname.slice(prefix.length).split("/").map(decodeURIComponent)
            : [];
    } catch {
        throw new WebSocketDispatchError();
    }
    const [computerId, harnesses, harness, sessions, sessionId, events] = parts;
    if (
        parts.length !== 6 ||
        computerId === undefined ||
        harness === undefined ||
        sessionId === undefined ||
        harnesses !== "harnesses" ||
        sessions !== "sessions" ||
        events !== "events"
    ) {
        throw new WebSocketDispatchError();
    }
    return { computerId, harness, sessionId };
}

function bearerCredential(frameHeaders: Headers): string {
    const credential = readBearerToken(frameHeaders);
    if (credential === undefined) {
        throw new WebSocketDispatchError();
    }
    return credential;
}

function requestFromMessage(
    value: Readonly<Record<string, unknown>>,
    origin: string,
    signal: AbortSignal,
    binaryBody?: Uint8Array,
): { readonly request: Request; readonly body: string } {
    const endpoint = framePath(value, origin);
    const method = string(value, "method", 16);
    if (!REQUEST_METHODS.some((allowed) => allowed === method)) {
        throw transportError("invalid_method");
    }
    const textBody = requestBody(value);
    const body = binaryBody ?? textBody;
    const requestHeaders = headers(value["headers"]);
    return {
        request: new Request(endpoint, {
            body: body.length === 0 || method === "GET" ? null : typeof body === "string" ? body : body.slice().buffer,
            headers: requestHeaders,
            method,
            signal,
        }),
        body: textBody,
    };
}

function responseHeaders(response: Response): readonly (readonly [string, string])[] {
    return Array.from(response.headers.entries()).filter(
        ([name]) => !FORBIDDEN_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith("sec-websocket-"),
    );
}

/**
 * One browser connection. Its open subscriptions are the only state that must outlive the Relay's memory: each change
 * to them is saved through `saveSubscriptions`, and the ones in `subscriptions` are reopened when the transport opens.
 */
export function openBrowserTransport(
    connection: BrowserTransportConnection,
    ports: BrowserTransportPorts,
): BrowserTransport {
    const server = connection.socket;
    const { dispatch, subscribe } = ports;
    const controller = new AbortController();
    const subscriptions = new Map<
        string,
        | { readonly kind: "pending"; readonly controller: AbortController }
        | { readonly kind: "open"; readonly controller: AbortController; readonly identity: SessionViewerIdentity }
    >();
    const connectionUploads = new WebSocketUploadCapacity();
    const binaryRequests = new Map<string, PendingBinaryUpload>();
    const requests = new Map<string, AbortController>();
    let subscriptionDiagnosticCount = 0;
    const saveSubscriptions = (): void => {
        connection.saveSubscriptions(
            [...subscriptions.values()].flatMap((subscription) =>
                subscription.kind === "open" ? [subscription.identity] : [],
            ),
        );
    };
    const sendSubscriptionError = (subscriptionId: string, cause: unknown): void => {
        const error = toHttpError(cause);
        server.send(
            JSON.stringify({
                kind: "session.events.error",
                subscriptionId,
                code: error.body.error.code,
                message: error.body.error.message,
                status: error.status,
            }),
        );
    };
    /**
     * Delivers one subscription's events and ends it when its viewer closes. The delivery figures in its diagnostic
     * cover only this Relay instance; they are not kept across hibernation.
     */
    const observeSubscription = (subscriptionId: string, subscriptionController: AbortController, path: string) => {
        const openedAt = Date.now();
        let delivered = 0;
        let lastMessageAt: number | null = null;
        const pendingMessages: string[] = [];
        let pendingBytes = 0;
        const close = (code: number, reason: string): void => {
            const current = subscriptions.get(subscriptionId);
            if (current?.controller === subscriptionController) {
                subscriptions.delete(subscriptionId);
                if (current.kind === "open") {
                    saveSubscriptions();
                }
                if (server.readyState === WebSocket.OPEN) {
                    const unexpected = code !== 1000 && code !== 1001;
                    // A flapping subscription must not produce an unbounded log stream.
                    // Normal unsubscribe, browser close, and clean upstream close remain quiet.
                    if (unexpected && subscriptionDiagnosticCount < MAX_SUBSCRIPTION_DIAGNOSTICS) {
                        subscriptionDiagnosticCount += 1;
                        const now = Date.now();
                        logger.warn(
                            {
                                event: "session_event_subscription_disconnected",
                                source: "upstream_close",
                                path,
                                subscriptionId,
                                elapsedMilliseconds: Math.max(0, now - openedAt),
                                lastMessageAgeMilliseconds:
                                    lastMessageAt === null ? null : Math.max(0, now - lastMessageAt),
                                messageCount: delivered,
                                closeCode: code,
                                closeReason: diagnosticText(reason, 256),
                                wasClean: !unexpected,
                            },
                            "Session event subscription disconnected",
                        );
                    }
                    if (code === 1012) {
                        sendSubscriptionError(subscriptionId, transportError(SESSION_SUBSCRIPTION_REPLACED));
                    } else if (current.kind === "pending") {
                        sendSubscriptionError(subscriptionId, transportError("session_unavailable"));
                    } else {
                        server.send(JSON.stringify({ kind: "session.events.end", subscriptionId }));
                    }
                }
            }
            subscriptionController.abort(new DOMException("Session event subscription closed", "AbortError"));
        };
        const message = (data: string): void => {
            const current = subscriptions.get(subscriptionId);
            if (current?.controller !== subscriptionController) {
                return;
            }
            // Admission may await alarm persistence after the listener is registered.
            if (current.kind === "pending") {
                pendingBytes += new TextEncoder().encode(data).byteLength;
                if (pendingBytes > MAX_BODY_BYTES) {
                    close(1013, "Session subscription backpressure");
                } else {
                    pendingMessages.push(data);
                }
                return;
            }
            if (server.readyState === WebSocket.OPEN) {
                lastMessageAt = Date.now();
                delivered += 1;
                server.send(JSON.stringify({ data, eventId: "", kind: "session.events.event", subscriptionId }));
            }
        };
        const flush = (): void => {
            for (const data of pendingMessages.splice(0)) {
                message(data);
            }
        };
        return { message, close, flush };
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
        const ended = [...subscriptions.values()];
        subscriptions.clear();
        // The saved record must not outlive the subscriptions, or a later wake would reopen them for a closed socket.
        saveSubscriptions();
        for (const subscription of ended) {
            subscription.controller.abort(new DOMException("WebSocket transport closed", "AbortError"));
        }
        releaseAllBinaryRequests();
        for (const pending of requests.values()) {
            pending.abort(new DOMException("WebSocket transport closed", "AbortError"));
        }
        requests.clear();
    };
    const receive = async (data: string | ArrayBuffer): Promise<void> => {
        let requestId = "unknown";
        let operation: PendingRequest | null = null;
        try {
            let decoded: unknown;
            let binaryBody: Uint8Array | undefined;
            if (typeof data === "string") {
                decoded = JSON.parse(data);
            } else {
                const arrayBuffer =
                    typeof data === "object" && data !== null ? Reflect.get(data, "arrayBuffer") : undefined;
                const binary = typeof arrayBuffer === "function" ? await Reflect.apply(arrayBuffer, data, []) : data;
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
                    upload.progressed();
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
            if (kind === CHANGES_FOLLOW_KIND) {
                const credential = readBearerToken(headers(message["headers"]));
                try {
                    await connection.saveFollow(
                        await ports.follow(connection.computerId, credential, controller.signal),
                    );
                } catch (cause) {
                    if (controller.signal.aborted) {
                        return;
                    }
                    await connection.saveFollow(null);
                    const error = toHttpError(cause);
                    server.send(
                        JSON.stringify({
                            kind: CHANGES_ERROR_KIND,
                            code: error.body.error.code,
                            message: error.body.error.message,
                            status: error.status,
                        }),
                    );
                    return;
                }
                server.send(JSON.stringify({ kind: CHANGES_READY_KIND }));
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
                subscriptions.delete(subscriptionId);
                if (subscription?.kind === "open") {
                    saveSubscriptions();
                }
                subscription?.controller.abort(new DOMException("Session event subscription closed", "AbortError"));
                return;
            }
            if (kind === EVENT_SUBSCRIBE_KIND) {
                const subscriptionId = string(message, "subscriptionId", 128);
                if (!FRAME_IDENTIFIER_PATTERN.test(subscriptionId) || subscriptions.has(subscriptionId)) {
                    throw transportError("invalid_message");
                }
                requestId = subscriptionId;
                const encoded = requestBody(message);
                let subscription: SessionEventsSubscribeCommandRouting;
                try {
                    subscription = sessionEventsSubscribeCommandCodec.decodeRouting(encoded);
                    if (subscription.subscriptionId !== subscriptionId) {
                        throw transportError("invalid_message");
                    }
                } catch {
                    throw transportError("invalid_message");
                }
                const endpoint = framePath(message, RELAY_INTERNAL_ORIGIN);
                const frameHeaders = headers(message["headers"]);
                const address = subscriptionAddress(endpoint);
                const credential = bearerCredential(frameHeaders);
                if (subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
                    sendSubscriptionError(subscriptionId, transportError("request_capacity_exceeded"));
                    return;
                }
                const subscriptionController = new AbortController();
                subscriptions.set(subscriptionId, { controller: subscriptionController, kind: "pending" });
                const observer = observeSubscription(subscriptionId, subscriptionController, endpoint.pathname);
                let identity: SessionViewerIdentity;
                try {
                    identity = await subscribe(
                        { ...address, credential, command: subscription, signal: subscriptionController.signal },
                        observer,
                    );
                    subscriptionController.signal.throwIfAborted();
                } catch (cause) {
                    if (subscriptions.get(subscriptionId)?.controller === subscriptionController) {
                        subscriptions.delete(subscriptionId);
                    }
                    const cancelled = subscriptionController.signal.aborted;
                    subscriptionController.abort(cause);
                    if (cancelled) {
                        return;
                    }
                    if (cause instanceof WebSocketDispatchError) {
                        throw cause;
                    }
                    sendSubscriptionError(subscriptionId, cause);
                    return;
                }
                subscriptions.set(subscriptionId, { kind: "open", controller: subscriptionController, identity });
                saveSubscriptions();
                server.send(
                    JSON.stringify({
                        kind: "session.events.ready",
                        subscriptionId,
                    }),
                );
                observer.flush();
                return;
            }
            const bodyByteLength = message["bodyByteLength"];
            if (binaryBody === undefined && bodyByteLength !== undefined) {
                requestId = requestIdFromMessage(message);
                if (
                    !Number.isSafeInteger(bodyByteLength) ||
                    typeof bodyByteLength !== "number" ||
                    bodyByteLength < 1 ||
                    requestBody(message).length !== 0 ||
                    binaryRequests.has(requestId)
                ) {
                    throw transportError("invalid_message");
                }
                const declaration = requestFromMessage(
                    message,
                    RELAY_INTERNAL_ORIGIN,
                    controller.signal,
                    new Uint8Array(0),
                );
                if (declaration.request.method === "GET") {
                    throw transportError("invalid_message");
                }
                const encryptedUpload = isEncryptedContentUpload(declaration.request);
                if (bodyByteLength > (encryptedUpload ? CONTENT_UPLOAD_MAX_ENCODED_BYTES : MAX_BODY_BYTES)) {
                    throw transportError("invalid_message");
                }
                const upload = new PendingBinaryUpload(
                    bodyByteLength,
                    message,
                    connectionUploads,
                    encryptedUpload,
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
            const converted = requestFromMessage(message, RELAY_INTERNAL_ORIGIN, controller.signal, binaryBody);
            operation = new PendingRequest(requestId, controller.signal, requests);
            const response = await dispatch({
                kind: "request",
                request: converted.request,
                body: converted.body,
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
    };
    for (const identity of connection.subscriptions) {
        const subscriptionController = new AbortController();
        subscriptions.set(identity.subscriptionId, { kind: "open", controller: subscriptionController, identity });
        ports.restore(
            connection.computerId,
            identity,
            observeSubscription(
                identity.subscriptionId,
                subscriptionController,
                `${MORTY_API_PREFIX}/v1/computers/${connection.computerId}/harnesses/${identity.sessionFilter.harness}/sessions/${identity.sessionFilter.sessionId}/events`,
            ),
            subscriptionController.signal,
        );
    }
    return { receive, release };
}
