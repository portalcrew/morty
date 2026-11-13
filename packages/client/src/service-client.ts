import {
    CONTENT_WRITE_MAX_BYTES,
    decodeInteractionAccepted,
    decodeKnownSessionEventLogPage,
    decodeKnownSessionLiveEventBatch,
    decodeNativeSessionResult,
    decodePromptAttachment,
    decodeSessionConfigReadResult,
    decodeSessionConfigUpdatedEvent,
    decodeSessionRenamedEvent,
    decodeTurn,
    decodeTurnCancellation,
    decodeTurnReference,
    type ExternalAudioContentBlock,
    type ExternalImageContentBlock,
    type ExternalResourceContentBlock,
    MORTY_API_PREFIX,
    type NativeSessionResult,
    type NativeSessionTarget,
    type PromptAttachment,
    type SessionConfigureCommand,
    type SessionEventLogPage,
    type SessionLiveEventBatch,
    SessionPromptDisposition,
    type Turn,
    type TurnReference,
} from "@morty-build/client/protocol";
import type { MortyEndpointCall } from "./calls/call.ts";
import { sessionEndpoints } from "./calls/session.ts";
import {
    MortyApiError,
    MortyCancellationError,
    MortyConnectionError,
    MortyError,
    MortyProtocolError,
    MortyTimeoutError,
    MortyValidationError,
} from "./errors.ts";
import { sameNativeSession } from "./native-session.ts";
import type {
    MortyInteractionResponseRequest,
    MortyPageRequest,
    MortyTurnCancellation,
    SubmitMortyTurnRequest,
} from "./resources.ts";
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
export type UpdateMortySessionConfigurationRequest = Pick<
    SessionConfigureCommand,
    "booleanValue" | "configId" | "expectedConfigurationRevision" | "value" | "valueType"
>;

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

    readonly get = async (endpoint: MortyEndpointCall, signal: AbortSignal): Promise<unknown> =>
        await this.request(endpoint, "", false, signal);

    readonly getFile = async (
        endpoint: MortyEndpointCall,
        maximumBytes: number,
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
                body: null,
                headers: this.authenticationHeaders(credential, "application/octet-stream"),
                signal: deadline.signal,
            });
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            if (!response.ok) {
                await throwApiError(response);
            }
            const mediaType = response.headers.get("content-type") ?? "";
            const modifiedAt = response.headers.get("last-modified") ?? "";
            const encodedName = response.headers.get("x-morty-file-name") ?? "";
            const encodedLength = response.headers.get("x-morty-byte-length") ?? "";
            if (
                mediaType.length === 0 ||
                mediaType.length > 255 ||
                modifiedAt.length === 0 ||
                !/^\d+$/.test(encodedLength)
            ) {
                throw new MortyProtocolError("The service returned invalid file metadata");
            }
            const byteLength = Number(encodedLength);
            if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > maximumBytes) {
                throw new MortyProtocolError("The service returned an invalid file size");
            }
            let name: string;
            try {
                name = decodeURIComponent(encodedName);
            } catch (cause) {
                throw new MortyProtocolError("The service returned an invalid file name", { cause });
            }
            return {
                bytes: await readExactResponseBytes(response, byteLength, deadline.signal),
                mediaType,
                modifiedAt,
                name,
            };
        } catch (cause) {
            if (!signal.aborted) {
                this.#lifetime.signal.throwIfAborted();
            }
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    readonly post = async (endpoint: MortyEndpointCall, body: unknown, signal: AbortSignal): Promise<unknown> => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MortyValidationError("The Morty request body is invalid");
        }
        return await this.request(endpoint, encoded, true, signal);
    };

    readonly put = async (endpoint: MortyEndpointCall, body: unknown, signal: AbortSignal): Promise<unknown> => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MortyValidationError("The Morty request body is invalid");
        }
        return await this.request(endpoint, encoded, true, signal);
    };

    readonly putContent = async (
        endpoint: MortyEndpointCall,
        bytes: Uint8Array,
        metadata: { readonly contentKind: "image" | "resource"; readonly mediaType: string; readonly name: string },
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new RequestDeadline(
            AbortSignal.any([signal, this.#lifetime.signal]),
            this.#operationTimeoutMilliseconds ?? endpoint.timeoutMilliseconds,
        );
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const headers = {
                ...this.authenticationHeaders(credential, "application/json"),
                "content-type": metadata.mediaType,
                "x-morty-byte-length": bytes.byteLength.toString(),
                "x-morty-content-kind": metadata.contentKind,
                "x-morty-file-name": encodeURIComponent(metadata.name),
            };
            const response = await this.#transport.fetch({
                endpoint,
                origin: this.#endpoint,
                body: bytes.slice(),
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
            return await responseValue(response);
        } catch (cause) {
            if (!signal.aborted) {
                this.#lifetime.signal.throwIfAborted();
            }
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };

    readonly openLiveEventStream = async (
        endpoint: MortyEndpointCall,
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
            const events = await this.#transport.openSessionLiveEvents({
                endpoint,
                origin: this.#endpoint,
                body: null,
                headers: this.authenticationHeaders(credential, "application/json"),
                signal: controller.signal,
            });
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
        body: string,
        hasBody: boolean,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new RequestDeadline(
            AbortSignal.any([signal, this.#lifetime.signal]),
            this.#operationTimeoutMilliseconds ?? endpoint.timeoutMilliseconds,
        );
        try {
            const credential = validateCredential(await this.#credentialProvider.credential(deadline.signal));
            const headers = {
                ...this.authenticationHeaders(credential, "application/json"),
                ...(hasBody ? { "content-type": "application/json" } : {}),
            };
            const response = await this.#transport.fetch({
                endpoint,
                origin: this.#endpoint,
                body: hasBody ? body : null,
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
            return await responseValue(response);
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

async function readExactResponseBytes(
    response: Response,
    expectedByteLength: number,
    signal: AbortSignal,
): Promise<Uint8Array> {
    const declaredLength = response.headers.get("content-length");
    if (
        declaredLength !== null &&
        (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) !== expectedByteLength)
    ) {
        throw new MortyProtocolError("The service returned an invalid artifact length");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new MortyProtocolError("The service returned no artifact content");
    }
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) {
                break;
            }
            byteLength += chunk.value.byteLength;
            if (byteLength > expectedByteLength) {
                await reader.cancel("Artifact response exceeded its metadata");
                throw new MortyProtocolError("The service returned an oversized artifact");
            }
            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    if (byteLength !== expectedByteLength) {
        throw new MortyProtocolError("The service returned an incomplete artifact");
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
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
    ) =>
        decodeSessionConfigUpdatedEvent(
            JSON.stringify(
                await this.#executor.post(
                    sessionEndpoints.updateConfiguration({ computerId: this.#computerId, target }),
                    request,
                    signal,
                ),
            ),
        );

    readonly readConfiguration = async (target: NativeSessionTarget, signal: AbortSignal) =>
        decodeSessionConfigReadResult(
            JSON.stringify(
                await this.#executor.get(
                    sessionEndpoints.readConfiguration({ computerId: this.#computerId, target }),
                    signal,
                ),
            ),
        );

    readonly rename = async (target: NativeSessionTarget, title: string, signal: AbortSignal) =>
        decodeSessionRenamedEvent(
            JSON.stringify(
                await this.#executor.post(
                    sessionEndpoints.rename({ computerId: this.#computerId, target }),
                    { title },
                    signal,
                ),
            ),
        );

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
        return decodePromptAttachment(
            await this.#executor.putContent(
                sessionEndpoints.uploadContent({
                    computerId: this.#computerId,
                    target: sessionTarget,
                    key: input.contentKey,
                    uri: input.uri,
                }),
                input.bytes,
                { contentKind: input.kind, mediaType: input.mediaType, name: input.name },
                signal,
            ),
        );
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
        return await this.#executor.getFile(
            sessionEndpoints.readFile({ computerId: this.#computerId, target: sessionTarget, path, maximumBytes }),
            maximumBytes,
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
    ): Promise<
        Pick<
            Extract<NativeSessionResult, { readonly action: "active-turn" }>,
            "turn" | "queued" | "command" | "lastTurn" | "queuedCancellation" | "interactionState" | "executionPosition"
        >
    > => {
        const result = decodeNativeSessionResult(
            JSON.stringify(
                await this.#executor.get(
                    sessionEndpoints.readExecution({
                        computerId: this.#computerId,
                        target: sessionTarget,
                        ...(commandId === undefined ? {} : { commandId }),
                    }),
                    signal,
                ),
            ),
        );
        if (result.action !== "active-turn" || !sameNativeSession(result.target, sessionTarget)) {
            throw new MortyProtocolError("The service returned an invalid active Turn");
        }
        return {
            turn: result.turn,
            queued: result.queued,
            ...(result.command === undefined ? {} : { command: result.command }),
            ...(result.lastTurn === undefined ? {} : { lastTurn: result.lastTurn }),
            queuedCancellation: result.queuedCancellation,
            interactionState: result.interactionState,
            executionPosition: result.executionPosition,
        };
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
        const turn = decodeTurn(
            await this.#executor.post(
                sessionEndpoints.submitTurn({ computerId: this.#computerId, target: sessionTarget }),
                request,
                signal,
            ),
        );
        if (turn === null) {
            throw new MortyProtocolError("The service returned an invalid Turn");
        }
        return turn;
    };

    readonly cancel = async (
        sessionTarget: NativeSessionTarget,
        turnId: string,
        signal: AbortSignal,
    ): Promise<MortyTurnCancellation> =>
        this.#answeredFor(
            turnId,
            "Turn cancellation",
            decodeTurnCancellation,
            await this.#executor.post(
                sessionEndpoints.cancelTurn({ computerId: this.#computerId, target: sessionTarget, turnId }),
                {},
                signal,
            ),
        );

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
        this.#answeredFor(
            turnId,
            "queued cancellation",
            decodeTurnReference,
            await this.#executor.post(
                sessionEndpoints.cancelQueuedTurn({ computerId: this.#computerId, target: sessionTarget, turnId }),
                {},
                signal,
            ),
        );
    };

    readonly steer = async (
        sessionTarget: NativeSessionTarget,
        turnId: string,
        signal: AbortSignal,
    ): Promise<{ readonly turnId: string }> => {
        return this.#answeredFor(
            turnId,
            "steered Turn",
            decodeTurnReference,
            await this.#executor.put(
                sessionEndpoints.steerTurn({ computerId: this.#computerId, target: sessionTarget, turnId }),
                { disposition: SessionPromptDisposition.Steer },
                signal,
            ),
        );
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
        const result = await this.#executor.post(
            sessionEndpoints.respond({ computerId: this.#computerId, target: sessionTarget, interactionId }),
            request,
            signal,
        );
        try {
            decodeInteractionAccepted(result);
        } catch (cause) {
            throw new MortyProtocolError("The service returned an invalid Interaction response", { cause });
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
    #closed = false;
    readonly connected: Promise<void>;
    readonly completed: Promise<void>;

    constructor(
        executor: MortyRequestExecutor,
        endpoint: MortyEndpointCall,
        observer: MortySessionEventObserver,
        signal: AbortSignal,
    ) {
        this.#executor = executor;
        this.#observer = observer;
        this.#endpoint = endpoint;
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
            connection = await this.#executor.openLiveEventStream(this.#endpoint, this.#controller.signal);
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
                    let value: unknown;
                    try {
                        value = JSON.parse(result.value.data);
                    } catch (cause) {
                        throw new MortyProtocolError("The live session event stream contains invalid JSON", {
                            cause,
                        });
                    }
                    const events = decodeKnownSessionLiveEventBatch(value);
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
        return decodeKnownSessionEventLogPage(
            await this.#executor.get(
                sessionEndpoints.listEvents({
                    computerId: this.#computerId,
                    target: sessionTarget,
                    limit: page.limit,
                    cursor: page.cursor,
                }),
                signal,
            ),
        );
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
