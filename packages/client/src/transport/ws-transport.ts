import {
    CONTENT_CHUNK_MAX_BYTES,
    encodeContentChunkFrame,
    isIdentifier,
    MORTY_API_PREFIX,
} from "@morty-build/client/protocol";
import type { MortyTransportCall } from "../calls/call.ts";
import { computerEncryptionAccessCodec } from "../calls/encryption.ts";
import {
    type ComputerEncryptionAccess,
    createClientPayloadEncryption,
    type PayloadDecryptor,
    type PayloadEncryptionConnection,
    type PayloadEncryptor,
} from "../encryption.ts";
import { MortyApiError, MortyConnectionError, MortyProtocolError, MortyValidationError } from "../errors.ts";
import { decodeMessageKind } from "../protocol/shared/message-codec.ts";
import { sessionEventEnvelopeCodec } from "../protocol/session/events/index.ts";
import { sessionCloseNoticeEventCodec } from "../protocol/session/lifecycle/index.ts";

const CONNECTION_TIMEOUT_MILLISECONDS = 15_000;
const HEARTBEAT_INTERVAL_MILLISECONDS = 20_000;
const HEARTBEAT_TIMEOUT_MILLISECONDS = 10_000;
const MAX_PENDING_LIVE_FANOUTS = 128;
const MAX_PENDING_LIVE_FANOUT_BYTES = 32 * 1024 * 1024;

export interface MortyTransportSessionEvent {
    readonly data: string;
    readonly eventId: string;
    readonly seqId: number;
}

export interface MortyWebSocketConnector {
    readonly connect: (endpoint: URL, signal: AbortSignal) => Promise<WebSocket>;
}

export interface WsTransportOptions {
    /** Opens the WebSocket; the browser's own WebSocket unless a test supplies a stateful socket. */
    readonly connector?: MortyWebSocketConnector;
}

type PayloadConnectionState =
    | { readonly kind: "idle" }
    | {
          readonly kind: "opening";
          readonly scope: string;
          readonly operation: Promise<PayloadEncryptionConnection>;
          readonly controller: AbortController;
      }
    | { readonly kind: "open"; readonly connection: PayloadEncryptionConnection };

type WsTransportState =
    | { readonly kind: "closed" }
    | {
          readonly kind: "connected";
          readonly socket: WebSocket;
      }
    | { readonly kind: "connecting"; readonly connection: Promise<WebSocket>; readonly controller: AbortController }
    | { readonly kind: "disconnected" };

type PendingWsRequest = {
    readonly reject: (cause: unknown) => void;
    readonly resolve: (response: Response) => void;
};
type LiveEventSubscription =
    | {
          readonly cleanup: () => void;
          readonly kind: "opening";
          readonly reject: (cause: unknown) => void;
          readonly resolve: (events: ReadableStream<MortyTransportSessionEvent>) => void;
      }
    | {
          readonly cleanup: () => void;
          readonly controller: ReadableStreamDefaultController<MortyTransportSessionEvent>;
          readonly kind: "open";
          readonly scope: string;
       };

type LiveMessage =
    | Awaited<ReturnType<typeof sessionEventEnvelopeCodec.decode>>
    | Awaited<ReturnType<typeof sessionCloseNoticeEventCodec.decode>>;
interface LiveDecryption {
    readonly read: () => Promise<LiveMessage>;
}
interface PendingLiveFanout {
    readonly remaining: Set<string>;
    readonly decryption: LiveDecryption;
    readonly bytes: number;
}

const WS_REQUEST_KIND = "http.request";
const WS_RESPONSE_KIND = "http.response";
const WS_ERROR_KIND = "http.error";
const EVENT_SUBSCRIBE_KIND = "session.events.subscribe";
const EVENT_UNSUBSCRIBE_KIND = "session.events.unsubscribe";
const SAFE_WEBSOCKET_CLOSE_REASONS = new Set(["WebSocket transport closed", "WebSocket transport idle timeout"]);

function webSocketCloseError(event: CloseEvent, action: "connect" | "remain connected"): MortyConnectionError {
    const reason = SAFE_WEBSOCKET_CLOSE_REASONS.has(event.reason) ? `: ${event.reason}` : "";
    return new MortyConnectionError(`The Morty WebSocket could not ${action} (close code ${event.code}${reason})`);
}

function wsRecord(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new MortyProtocolError("The WebSocket transport returned an invalid message");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function wsString(value: Readonly<Record<string, unknown>>, field: string, maximum: number): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length > maximum) {
        throw new MortyProtocolError("The WebSocket transport returned an invalid message");
    }
    return candidate;
}

function wsPositiveInteger(value: Readonly<Record<string, unknown>>, field: string): number {
    const candidate = value[field];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) {
        throw new MortyProtocolError("The WebSocket transport returned an invalid message");
    }
    return candidate;
}

function wsHeaders(value: unknown): Headers {
    if (!Array.isArray(value) || value.length > 128) {
        throw new MortyProtocolError("The WebSocket transport returned invalid response headers");
    }
    const headers = new Headers();
    for (const entry of value) {
        if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== "string" ||
            typeof entry[1] !== "string" ||
            entry[0].length > 256 ||
            entry[1].length > 16_384
        ) {
            throw new MortyProtocolError("The WebSocket transport returned invalid response headers");
        }
        headers.append(entry[0], entry[1]);
    }
    return headers;
}

class RelayMortyWebSocketConnector implements MortyWebSocketConnector {
    readonly connect = async (endpoint: URL, signal: AbortSignal): Promise<WebSocket> => {
        signal.throwIfAborted();
        const socket = new WebSocket(endpoint.toString());
        return await new Promise<WebSocket>((resolve, reject) => {
            let completed = false;
            const cleanup = (): void => {
                signal.removeEventListener("abort", abort);
                socket.removeEventListener("close", close);
                socket.removeEventListener("error", error);
                socket.removeEventListener("open", open);
            };
            const fail = (cause: unknown): void => {
                if (completed) {
                    return;
                }
                completed = true;
                cleanup();
                socket.close();
                reject(cause);
            };
            const abort = (): void => fail(signal.reason);
            const close = (event: CloseEvent): void => fail(webSocketCloseError(event, "connect"));
            const error = (): void =>
                fail(new MortyConnectionError("The browser reported an error while connecting the Morty WebSocket"));
            const open = (): void => {
                if (completed) {
                    return;
                }
                completed = true;
                cleanup();
                resolve(socket);
            };
            signal.addEventListener("abort", abort, { once: true });
            socket.addEventListener("close", close, { once: true });
            socket.addEventListener("error", error, { once: true });
            socket.addEventListener("open", open, { once: true });
            if (signal.aborted) {
                abort();
            }
        });
    };
}

export class WsTransport {
    readonly #connector: MortyWebSocketConnector;
    readonly #pending = new Map<string, PendingWsRequest>();
    readonly #subscriptions = new Map<string, LiveEventSubscription>();
    readonly #liveDecryptions = new WeakMap<MortyTransportSessionEvent, LiveDecryption>();
    readonly #pendingLiveFanouts = new Map<string, Map<string, PendingLiveFanout>>();
    #pendingLiveFanoutCount = 0;
    #pendingLiveFanoutBytes = 0;
    #liveDecryptionController = new AbortController();
    #endpoint: string | null = null;
    #state: WsTransportState = { kind: "disconnected" };
    #access: ComputerEncryptionAccess | null = null;
    #payload: PayloadConnectionState = { kind: "idle" };
    #heartbeat:
        | { readonly kind: "inactive" }
        | { readonly kind: "waiting" | "awaiting"; readonly timer: ReturnType<typeof globalThis.setTimeout> } = {
        kind: "inactive",
    };

    constructor(options: WsTransportOptions = {}) {
        this.#connector = options.connector ?? new RelayMortyWebSocketConnector();
    }

    readonly payloadEncryption: PayloadEncryptor & PayloadDecryptor = {
        encrypt: async (plaintext, associatedData, signal) => {
            const access = this.#access;
            if (access === null) {
                throw new MortyValidationError("Encrypted Computer access is required");
            }
            const connection = await this.#payloadConnection(access.computerId, signal);
            return await connection.encrypt(plaintext, associatedData, signal);
        },
        decrypt: async (ciphertext, associatedData, signal) => {
            const access = this.#access;
            if (access === null) {
                throw new MortyValidationError("Encrypted Computer access is required");
            }
            const connection = await this.#payloadConnection(access.computerId, signal);
            return await connection.decrypt(ciphertext, associatedData, signal);
        },
    };

    readonly configureEncryption = (value: ComputerEncryptionAccess): void => {
        const access = computerEncryptionAccessCodec.decode(computerEncryptionAccessCodec.encode(value));
        if (this.#state.kind === "closed") {
            throw new MortyConnectionError("The Morty WebSocket transport is closed");
        }
        if (this.#access !== null) {
            if (
                this.#access.computerId !== access.computerId ||
                this.#access.computerE2EPublicKey !== access.computerE2EPublicKey ||
                this.#access.computerE2EAccessSecret !== access.computerE2EAccessSecret
            ) {
                throw new MortyValidationError("A Computer connection cannot change encryption identity");
            }
            return;
        }
        this.#access = access;
    };

    readonly #payloadConnection = async (
        computerId: string,
        signal: AbortSignal,
    ): Promise<PayloadEncryptionConnection> => {
        signal.throwIfAborted();
        const access = this.#access;
        if (access === null || access.computerId !== computerId) {
            throw new MortyValidationError("Encrypted access to this Computer is required");
        }
        if (this.#payload.kind === "open") {
            return this.#payload.connection;
        }
        if (this.#payload.kind === "idle") {
            const controller = new AbortController();
            const operation = this.#openPayloadConnection(access, controller);
            this.#payload = { kind: "opening", operation, controller };
        }
        const operation = this.#payload.operation;
        return await new Promise<PayloadEncryptionConnection>((resolve, reject) => {
            const abort = (): void => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            operation.then(
                (connection) => {
                    signal.removeEventListener("abort", abort);
                    if (signal.aborted) {
                        reject(signal.reason);
                    } else {
                        resolve(connection);
                    }
                },
                (cause: unknown) => {
                    signal.removeEventListener("abort", abort);
                    reject(cause);
                },
            );
            if (signal.aborted) {
                abort();
            }
        });
    };

    readonly #openPayloadConnection = async (
        access: ComputerEncryptionAccess,
        controller: AbortController,
    ): Promise<PayloadEncryptionConnection> => {
        const timeout = globalThis.setTimeout(
            () => controller.abort(new MortyConnectionError("Computer encryption initialization timed out")),
            CONNECTION_TIMEOUT_MILLISECONDS,
        );
        try {
            const connection = await createClientPayloadEncryption(access, controller.signal);
            if (controller.signal.aborted || this.#state.kind === "closed") {
                connection.close();
                controller.signal.throwIfAborted();
                throw new MortyConnectionError("The Morty WebSocket transport is closed");
            }
            this.#payload = { kind: "open", connection };
            return connection;
        } catch (cause) {
            if (this.#payload.kind === "opening" && this.#payload.controller === controller) {
                this.#payload = { kind: "idle" };
            }
            throw cause;
        } finally {
            globalThis.clearTimeout(timeout);
        }
    };

    readonly #closePayloadConnection = (): void => {
        const payload = this.#payload;
        this.#payload = { kind: "idle" };
        if (payload.kind === "open") {
            payload.connection.close();
        } else if (payload.kind === "opening") {
            payload.controller.abort(new MortyConnectionError("The Computer connection closed"));
        }
    };

    readonly #cancelRequest = (socket: WebSocket, requestId: string): void => {
        if (socket.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            socket.send(JSON.stringify({ kind: "http.cancel", requestId }));
        } catch {
            // Cancellation is already final locally; never replay the operation.
        }
    };

    readonly fetch = async (request: MortyTransportCall): Promise<Response> => {
        request.signal.throwIfAborted();
        if (this.#state.kind === "closed") {
            throw new MortyConnectionError("The Morty WebSocket transport is closed");
        }
        const requestUrl = new URL(request.endpoint.path, request.origin);
        const transport = request.endpoint.transport;
        if (transport.kind === "http") {
            return await globalThis.fetch(requestUrl, {
                method: request.endpoint.method,
                headers: request.headers,
                body: request.body instanceof Uint8Array ? request.body.slice().buffer : request.body,
                signal: request.signal,
            });
        }
        const socket = await this.#socket(request);
        request.signal.throwIfAborted();
        const requestId = crypto.randomUUID();
        const binaryBody = request.body instanceof Uint8Array ? request.body : null;
        const body = typeof request.body === "string" ? request.body : "";
        request.signal.throwIfAborted();
        const response = new Promise<Response>((resolve, reject) => {
            const abort = (): void => {
                this.#pending.delete(requestId);
                reject(request.signal.reason);
                if (transport.cancellation === "remote") {
                    this.#cancelRequest(socket, requestId);
                }
            };
            request.signal.addEventListener("abort", abort, { once: true });
            this.#pending.set(requestId, {
                reject: (cause) => {
                    request.signal.removeEventListener("abort", abort);
                    reject(cause);
                },
                resolve: (value) => {
                    request.signal.removeEventListener("abort", abort);
                    resolve(value);
                },
            });
        });
        try {
            socket.send(
                JSON.stringify({
                    body,
                    headers: Object.entries(request.headers),
                    kind: WS_REQUEST_KIND,
                    method: request.endpoint.method,
                    path: `${requestUrl.pathname}${requestUrl.search}`,
                    requestId,
                    ...(binaryBody === null ? {} : { bodyByteLength: binaryBody.byteLength }),
                }),
            );
            if (binaryBody !== null) {
                let sequence = 0;
                for (let offset = 0; offset < binaryBody.byteLength; offset += CONTENT_CHUNK_MAX_BYTES) {
                    const chunk = encodeContentChunkFrame({
                        bytes: binaryBody.subarray(offset, offset + CONTENT_CHUNK_MAX_BYTES),
                        requestId,
                        sequence,
                    });
                    socket.send(chunk.slice().buffer);
                    sequence += 1;
                }
            }
        } catch (cause) {
            const pending = this.#pending.get(requestId);
            this.#pending.delete(requestId);
            pending?.reject(cause);
        }
        return await response;
    };

    readonly openSessionLiveEvents = async (
        request: MortyTransportCall,
        subscriptionId: string,
    ): Promise<ReadableStream<MortyTransportSessionEvent>> => {
        request.signal.throwIfAborted();
        const requestUrl = new URL(request.endpoint.path, request.origin);
        const socket = await this.#socket(request);
        request.signal.throwIfAborted();
        const id = subscriptionId;
        if (!isIdentifier(id) || this.#subscriptions.has(id)) {
            throw new MortyValidationError("The Session subscription identifier is invalid or already in use");
        }
        const abort = (): void => {
            const subscription = this.#subscriptions.get(id);
            this.#subscriptions.delete(id);
            subscription?.cleanup();
            if (subscription?.kind === "open") {
                this.#removeLiveFanoutSubscriber(id, subscription.scope);
            }
            if (subscription?.kind === "opening") {
                subscription.reject(request.signal.reason);
            } else {
                subscription?.controller.error(request.signal.reason);
            }
            this.#sendUnsubscribe(id);
        };
        const cleanup = (): void => request.signal.removeEventListener("abort", abort);
        const events = new Promise<ReadableStream<MortyTransportSessionEvent>>((resolve, reject) => {
            this.#subscriptions.set(id, { cleanup, kind: "opening", scope: requestUrl.href, reject, resolve });
        });
        request.signal.addEventListener("abort", abort, { once: true });
        try {
            socket.send(
                JSON.stringify({
                    body: typeof request.body === "string" ? request.body : "",
                    headers: Object.entries(request.headers),
                    kind: EVENT_SUBSCRIBE_KIND,
                    path: `${requestUrl.pathname}${requestUrl.search}`,
                    subscriptionId: id,
                }),
            );
        } catch (cause) {
            this.#subscriptions.delete(id);
            cleanup();
            throw cause;
        }
        return await events;
    };

    readonly close = (): void => {
        this.#closePayloadConnection();
        this.#stopHeartbeat();
        const state = this.#state;
        this.#state = { kind: "closed" };
        if (state.kind === "connected") {
            state.socket.close(1000, "Morty transport closed");
        } else if (state.kind === "connecting") {
            state.controller.abort(new MortyConnectionError("The Morty WebSocket transport closed"));
        }
        this.#failPending(new MortyConnectionError("The Morty WebSocket transport closed"));
        this.#failSubscriptions(new MortyConnectionError("The live Session event transport closed"));
    };

    readonly #socket = async (request: MortyTransportCall): Promise<WebSocket> => {
        const endpoint = new URL(
            `${MORTY_API_PREFIX}/v1/computers/${encodeURIComponent(request.endpoint.computerId)}/transport`,
            request.origin,
        );
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        if (this.#endpoint !== null && this.#endpoint !== endpoint.href) {
            throw new MortyValidationError("A WebSocket transport cannot connect to multiple computers");
        }
        this.#endpoint = endpoint.href;
        switch (this.#state.kind) {
            case "closed":
                throw new MortyConnectionError("The Morty WebSocket transport is closed");
            case "connected":
                return this.#state.socket;
            case "connecting":
                return await this.#waitForConnection(this.#state.connection, request.signal);
            case "disconnected": {
                const controller = new AbortController();
                const connection = this.#connect(endpoint, controller);
                this.#state = { kind: "connecting", connection, controller };
                return await this.#waitForConnection(connection, request.signal);
            }
        }
    };

    readonly #waitForConnection = async (connection: Promise<WebSocket>, signal: AbortSignal): Promise<WebSocket> => {
        signal.throwIfAborted();
        return await new Promise<WebSocket>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            connection.then(
                (socket) => {
                    signal.removeEventListener("abort", abort);
                    resolve(socket);
                },
                (cause: unknown) => {
                    signal.removeEventListener("abort", abort);
                    reject(cause);
                },
            );
        });
    };

    readonly #connect = async (endpoint: URL, controller: AbortController): Promise<WebSocket> => {
        const timeout = globalThis.setTimeout(
            () => controller.abort(new MortyConnectionError("The Morty WebSocket connection timed out")),
            CONNECTION_TIMEOUT_MILLISECONDS,
        );
        try {
            const socket = await this.#connector.connect(endpoint, controller.signal);
            if (this.#state.kind === "closed") {
                socket.close(1000, "Morty transport closed");
                throw new MortyConnectionError("The Morty WebSocket transport is closed");
            }
            socket.addEventListener("message", (event) => {
                if (this.#state.kind === "connected" && this.#state.socket === socket) {
                    this.#receive(event);
                }
            });
            socket.addEventListener(
                "close",
                (event) => this.#disconnected(socket, webSocketCloseError(event, "remain connected")),
                {
                    once: true,
                },
            );
            socket.addEventListener(
                "error",
                () =>
                    this.#disconnected(
                        socket,
                        new MortyConnectionError("The browser reported an error on the Morty WebSocket"),
                    ),
                { once: true },
            );
            this.#state = { kind: "connected", socket };
            this.#scheduleHeartbeat(socket);
            return socket;
        } catch (cause) {
            if (this.#state.kind !== "closed") {
                this.#state = { kind: "disconnected" };
            }
            if (cause instanceof MortyConnectionError) {
                throw cause;
            }
            throw new MortyConnectionError("The Morty WebSocket transport could not connect", { cause });
        } finally {
            globalThis.clearTimeout(timeout);
        }
    };

    readonly #receive = (event: MessageEvent): void => {
        try {
            if (typeof event.data !== "string") {
                throw new MortyProtocolError("The WebSocket transport returned a binary message");
            }
            const value: unknown = JSON.parse(event.data);
            const message = wsRecord(value);
            const kind = wsString(message, "kind", 32);
            if (kind === "pong" && Object.keys(message).length === 1 && this.#heartbeat.kind === "awaiting") {
                if (this.#state.kind === "connected") {
                    this.#scheduleHeartbeat(this.#state.socket);
                }
                return;
            }
            if (kind.startsWith("session.events.")) {
                this.#receiveSubscription(kind, message);
                return;
            }
            const requestId = wsString(message, "requestId", 128);
            const pending = this.#pending.get(requestId);
            if (pending === undefined) {
                return;
            }
            if (kind === WS_ERROR_KIND) {
                const status = message["status"];
                if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 400 || status > 599) {
                    throw new MortyProtocolError("The WebSocket transport returned an invalid error status");
                }
                pending.reject(
                    new MortyApiError(wsString(message, "code", 128), wsString(message, "message", 1_024), status),
                );
                this.#pending.delete(requestId);
                return;
            }
            if (kind !== WS_RESPONSE_KIND) {
                throw new MortyProtocolError("The WebSocket transport returned an unsupported message");
            }
            const status = message["status"];
            if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 200 || status > 599) {
                throw new MortyProtocolError("The WebSocket transport returned an invalid response status");
            }
            const body = wsString(message, "body", 16_777_216);
            pending.resolve(
                new Response(status === 204 || status === 205 || status === 304 ? null : body, {
                    headers: wsHeaders(message["headers"]),
                    status,
                }),
            );
            this.#pending.delete(requestId);
        } catch (cause) {
            this.#failPending(cause);
            this.#failSubscriptions(cause);
        }
    };

    readonly #disconnected = (socket: WebSocket, cause: MortyConnectionError): void => {
        if (this.#state.kind !== "connected" || this.#state.socket !== socket) {
            return;
        }
        this.#stopHeartbeat();
        this.#state = { kind: "disconnected" };
        this.#failPending(cause);
        this.#failSubscriptions(cause);
    };

    readonly #failPending = (cause: unknown): void => {
        const pending = Array.from(this.#pending.values());
        this.#pending.clear();
        for (const request of pending) {
            request.reject(cause);
        }
    };

    readonly #failSubscriptions = (cause: unknown): void => {
        const subscriptions = Array.from(this.#subscriptions.values());
        this.#subscriptions.clear();
        for (const subscription of subscriptions) {
            subscription.cleanup();
            if (subscription.kind === "opening") {
                subscription.reject(cause);
            } else {
                subscription.controller.error(cause);
            }
        }
    };

    readonly #receiveSubscription = (kind: string, message: Readonly<Record<string, unknown>>): void => {
        const id = wsString(message, "subscriptionId", 128);
        const subscription = this.#subscriptions.get(id);
        if (subscription === undefined) {
            return;
        }
        if (kind === "session.events.ready") {
            if (subscription.kind !== "opening") {
                throw new MortyProtocolError("The live Session event subscription became ready more than once");
            }
            let streamController: ReadableStreamDefaultController<MortyTransportSessionEvent> | null = null;
            const stream = new ReadableStream<MortyTransportSessionEvent>({
                start(controller) {
                    streamController = controller;
                },
                cancel: () => {
                    subscription.cleanup();
                    this.#subscriptions.delete(id);
                    this.#sendUnsubscribe(id);
                },
            });
            if (streamController === null) {
                throw new MortyProtocolError("The live Session event subscription could not initialize");
            }
            this.#subscriptions.set(id, { cleanup: subscription.cleanup, controller: streamController, kind: "open" });
            subscription.resolve(stream);
            return;
        }
        if (kind === "session.events.error") {
            const status = message["status"];
            if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 400 || status > 599) {
                throw new MortyProtocolError("The live Session event subscription returned an invalid status");
            }
            const cause = new MortyApiError(
                wsString(message, "code", 128),
                wsString(message, "message", 1_024),
                status,
            );
            this.#subscriptions.delete(id);
            subscription.cleanup();
            if (subscription.kind === "opening") {
                subscription.reject(cause);
            } else {
                subscription.controller.error(cause);
            }
            return;
        }
        if (subscription.kind !== "open") {
            throw new MortyProtocolError("The live Session event subscription received data before it was ready");
        }
        if (kind === "session.events.end") {
            this.#subscriptions.delete(id);
            subscription.cleanup();
            subscription.controller.close();
            return;
        }
        if (kind !== "session.events.event") {
            throw new MortyProtocolError("The live Session event subscription returned an unsupported message");
        }
        subscription.controller.enqueue({
            data: wsString(message, "data", 8 * 1024 * 1024),
            eventId: wsString(message, "eventId", 512),
            seqId: wsPositiveInteger(message, "seqId"),
        });
    };

    readonly #sendUnsubscribe = (id: string): void => {
        if (this.#state.kind !== "connected") {
            return;
        }
        this.#state.socket.send(JSON.stringify({ kind: EVENT_UNSUBSCRIBE_KIND, subscriptionId: id }));
    };

    readonly #stopHeartbeat = (): void => {
        if (this.#heartbeat.kind !== "inactive") {
            globalThis.clearTimeout(this.#heartbeat.timer);
        }
        this.#heartbeat = { kind: "inactive" };
    };

    readonly #scheduleHeartbeat = (socket: WebSocket): void => {
        this.#stopHeartbeat();
        this.#heartbeat = {
            kind: "waiting",
            timer: globalThis.setTimeout(() => {
                if (this.#state.kind !== "connected" || this.#state.socket !== socket) {
                    return;
                }
                this.#heartbeat = {
                    kind: "awaiting",
                    timer: globalThis.setTimeout(() => {
                        this.#disconnected(socket, new MortyConnectionError("The Morty WebSocket heartbeat timed out"));
                        socket.close(4001, "Morty transport heartbeat timed out");
                    }, HEARTBEAT_TIMEOUT_MILLISECONDS),
                };
                try {
                    socket.send('{"kind":"ping"}');
                } catch (cause) {
                    this.#disconnected(
                        socket,
                        new MortyConnectionError("The Morty WebSocket heartbeat failed", { cause }),
                    );
                    socket.close(4001, "Morty transport heartbeat failed");
                }
            }, HEARTBEAT_INTERVAL_MILLISECONDS),
        };
    };
}
