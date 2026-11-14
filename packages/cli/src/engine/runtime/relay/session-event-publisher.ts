import type { PayloadEncryptionConnection } from "@morty-build/client";
import { NativeSessionMap } from "@morty-build/client/native-session";
import {
    ENCRYPTED_MESSAGE_MAX_PLAINTEXT_BYTES,
    ENCRYPTED_MESSAGE_MAX_WIRE_BYTES,
    isPromptTerminal,
    type NativeSessionTarget,
    SESSION_EVENT_BATCH_MAX_SIZE,
    SESSION_EVENT_KIND,
    type SessionCloseNoticeEvent,
    type SessionLiveEvent,
    sessionCloseNoticeEventCodec,
    sessionEventEnvelopeCodec,
} from "@morty-build/client/protocol";
import { WebSocket } from "undici";
import type { SessionEventSink } from "../../session/api/session-api.ts";
import type { ScheduledTask, Timer } from "../../util/timer.ts";

const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BATCH_BYTES = 1024 * 1024;
// Browser-compatible WebSocket clients may initiate only 1000 or application close codes.
const LOCAL_BACKPRESSURE_CLOSE_CODE = 4009;
export const SESSION_EVENT_BATCH_WINDOW_MILLISECONDS = 100;

type PublisherConnection =
    | { readonly kind: "disconnected" }
    | {
          readonly kind: "connected";
          readonly socket: WebSocket;
          readonly controller: AbortController;
          readonly isSubscribed: (target: NativeSessionTarget) => boolean;
      }
    | { readonly kind: "closed" };

interface PendingBatch {
    readonly target: NativeSessionTarget;
    readonly events: SessionLiveEvent[];
    bytes: number;
}

/** Keeps unsent output in bounded memory across reconnects. Sent events are never replayed. */
export class RuntimeSessionEventPublisher implements SessionEventSink {
    readonly #pending: PendingBatch[] = [];
    readonly #awaitingFirstAnswer = new NativeSessionMap<{
        readonly commandId: string;
        readonly generationId: string;
    }>();
    #pendingBytes = 0;
    #overflowReported = false;
    #pendingTask: ScheduledTask | null = null;
    #flushing: Promise<void> | null = null;
    #sendingBatch: PendingBatch | null = null;
    #notices: Promise<void> = Promise.resolve();
    #noticeBytes = 0;
    #connection: PublisherConnection = { kind: "disconnected" };
    readonly #timer: Timer;
    readonly #payloadEncryption: PayloadEncryptionConnection;

    constructor(timer: Timer, payloadEncryption: PayloadEncryptionConnection) {
        this.#timer = timer;
        this.#payloadEncryption = payloadEncryption;
    }

    readonly connect = (socket: WebSocket, isSubscribed: (target: NativeSessionTarget) => boolean): void => {
        if (this.#connection.kind === "closed") {
            return;
        }
        this.#connection = { kind: "connected", socket, controller: new AbortController(), isSubscribed };
        // Hand off the unsent tail before a new command can publish newer events.
        this.flushEvents(socket);
    };

    readonly disconnect = (socket: WebSocket): void => {
        if (this.#connection.kind === "connected" && this.#connection.socket === socket) {
            this.#connection.controller.abort();
            this.#connection = { kind: "disconnected" };
            this.cancelFlush();
        }
    };

    readonly close = (): void => {
        if (this.#connection.kind === "connected") {
            this.#connection.controller.abort();
        }
        this.#connection = { kind: "closed" };
        this.cancelFlush();
        this.#pending.length = 0;
        this.#pendingBytes = 0;
        this.#awaitingFirstAnswer.clear();
    };

    readonly flush = (): Promise<void> => {
        if (this.#connection.kind === "connected") {
            this.flushEvents(this.#connection.socket);
        }
        return Promise.all([this.#flushing, this.#notices]).then(() => undefined);
    };

    readonly subscriptionsChanged = (): void => {
        if (this.#connection.kind === "connected") {
            this.flushEvents(this.#connection.socket);
        }
    };

    readonly publishClosed = (event: SessionCloseNoticeEvent): void => {
        this.#awaitingFirstAnswer.delete(event.target);
        const connection = this.#connection;
        if (
            connection.kind !== "connected" ||
            connection.socket.readyState !== WebSocket.OPEN ||
            !connection.isSubscribed(event.target)
        ) {
            return;
        }
        const socket = connection.socket;
        const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
        if (this.#noticeBytes + bytes > MAX_PENDING_BYTES) {
            socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event transport overloaded");
            return;
        }
        this.#noticeBytes += bytes;
        this.#notices = this.#notices
            .then(async () => {
                const signal = AbortSignal.any([connection.controller.signal, AbortSignal.timeout(10_000)]);
                const encoded = await sessionCloseNoticeEventCodec.encode(event, this.#payloadEncryption, signal);
                signal.throwIfAborted();
                if (!connection.isSubscribed(event.target)) {
                    return;
                }
                if (Buffer.byteLength(encoded, "utf8") > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES) {
                    console.warn("Session close notice exceeds the Relay frame limit", {
                        code: "live_notice_too_large",
                        target: event.target,
                    });
                    return;
                }
                if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
                    socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event transport overloaded");
                    return;
                }
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(encoded);
                }
            })
            .catch((error: unknown) => {
                if (!connection.controller.signal.aborted) {
                    console.warn("Session close notice could not be sent", error);
                    socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event handoff failed");
                }
            })
            .finally(() => {
                this.#noticeBytes -= bytes;
            });
    };

    readonly publish = (event: SessionLiveEvent): void => {
        if (this.#connection.kind === "closed") {
            return;
        }
        const bytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
        const envelopeBytes = Buffer.byteLength(
            JSON.stringify({ events: [], kind: SESSION_EVENT_KIND, target: event.target }),
        );
        const privateBytes = bytes + Buffer.byteLength('{"events":[]}');
        const routingBytes = Buffer.byteLength(
            JSON.stringify({ kind: SESSION_EVENT_KIND, target: event.target, encrypted: "" }),
        );
        // AES-GCM adds a 21-byte header and 16-byte tag; the packet is base64url encoded.
        const maximumWireBytes = routingBytes + Math.ceil(((privateBytes + 37) * 4) / 3);
        if (
            privateBytes > ENCRYPTED_MESSAGE_MAX_PLAINTEXT_BYTES ||
            maximumWireBytes > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES
        ) {
            console.warn("Live Session event exceeds the Relay frame limit", {
                code: "live_event_too_large",
                target: event.target,
                eventId: event.eventId,
                bytes,
            });
            return;
        }
        // Disconnected output remains available for bounded replay. Once a viewer
        // needs space, however, unviewed live output can be recovered from history
        // and must not consume the entire shared budget.
        const connection = this.#connection;
        if (
            connection.kind === "connected" &&
            connection.socket.readyState === WebSocket.OPEN &&
            connection.isSubscribed(event.target)
        ) {
            for (let index = 0; this.#pendingBytes + bytes + envelopeBytes > MAX_PENDING_BYTES; ) {
                const candidate = this.#pending[index];
                if (candidate === undefined) {
                    break;
                }
                if (candidate !== this.#sendingBatch && !connection.isSubscribed(candidate.target)) {
                    this.#pending.splice(index, 1);
                    this.#pendingBytes -= candidate.bytes;
                } else {
                    index += 1;
                }
            }
        }
        let batch = this.#pending.at(-1);
        const batchFull =
            batch !== undefined &&
            (batch.events.length >= SESSION_EVENT_BATCH_MAX_SIZE || batch.bytes + bytes > MAX_EVENT_BATCH_BYTES);
        const newBatch =
            batch === undefined ||
            batch === this.#sendingBatch ||
            batch.target.harness !== event.target.harness ||
            batch.target.sessionId !== event.target.sessionId ||
            batchFull;
        const additionalBytes = bytes + (newBatch ? envelopeBytes : 0);
        if (this.#pendingBytes + additionalBytes > MAX_PENDING_BYTES) {
            if (!this.#overflowReported) {
                this.#overflowReported = true;
                console.warn("Live Session output exceeded the pending buffer limit", {
                    code: "live_event_buffer_full",
                    target: event.target,
                    eventId: event.eventId,
                    maximumBytes: MAX_PENDING_BYTES,
                });
            }
            return;
        }
        if (batch === undefined || newBatch) {
            batch = { target: event.target, events: [], bytes: envelopeBytes };
            this.#pending.push(batch);
        }
        batch.events.push(event);
        batch.bytes += bytes;
        this.#pendingBytes += additionalBytes;
        const firstAnswer = this.#consumeFirstAnswer(event);
        if (connection.kind !== "connected" || connection.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const socket = connection.socket;
        if (
            firstAnswer ||
            batchFull ||
            batch.events.length >= SESSION_EVENT_BATCH_MAX_SIZE ||
            batch.bytes >= MAX_EVENT_BATCH_BYTES
        ) {
            this.flushEvents(socket);
            return;
        }
        this.#pendingTask ??= this.#timer.schedule(
            () => this.flushEvents(socket),
            SESSION_EVENT_BATCH_WINDOW_MILLISECONDS,
        );
    };

    readonly #consumeFirstAnswer = (event: SessionLiveEvent): boolean => {
        if (event.type === "lifecycle-metadata") {
            const payload = event.payload;
            if (payload.kind === "prompt.started") {
                this.#awaitingFirstAnswer.set(event.target, {
                    commandId: payload.commandId,
                    generationId: event.sessionGenerationId,
                });
            } else if (
                isPromptTerminal(payload) &&
                this.#awaitingFirstAnswer.get(event.target)?.commandId === payload.commandId &&
                this.#awaitingFirstAnswer.get(event.target)?.generationId === event.sessionGenerationId
            ) {
                this.#awaitingFirstAnswer.delete(event.target);
            }
            return false;
        }
        if (
            event.type !== "acp" ||
            event.payload.sessionUpdate !== "agent_message_chunk" ||
            event.payload.content.type !== "text" ||
            event.payload.content.text.length === 0 ||
            this.#awaitingFirstAnswer.get(event.target)?.generationId !== event.sessionGenerationId
        ) {
            return false;
        }
        this.#awaitingFirstAnswer.delete(event.target);
        return true;
    };

    private readonly cancelFlush = (): void => {
        this.#pendingTask?.cancel();
        this.#pendingTask = null;
    };

    private readonly flushEvents = (socket: WebSocket): void => {
        this.cancelFlush();
        const connection = this.#connection;
        if (
            connection.kind !== "connected" ||
            connection.socket !== socket ||
            socket.readyState !== WebSocket.OPEN ||
            this.#flushing !== null
        ) {
            return;
        }
        const operation = (async () => {
            try {
                while (this.#pending.length > 0) {
                    const index = this.#pending.findIndex((candidate) => connection.isSubscribed(candidate.target));
                    if (index < 0) {
                        break;
                    }
                    const batch = this.#pending[index];
                    if (batch === undefined) {
                        break;
                    }
                    this.#sendingBatch = batch;
                    const signal = AbortSignal.any([connection.controller.signal, AbortSignal.timeout(10_000)]);
                    const encoded = await sessionEventEnvelopeCodec.encode(
                        { events: batch.events, kind: SESSION_EVENT_KIND },
                        this.#payloadEncryption,
                        signal,
                    );
                    signal.throwIfAborted();
                    if (!connection.isSubscribed(batch.target)) {
                        this.#sendingBatch = null;
                        continue;
                    }
                    if (socket.readyState !== WebSocket.OPEN) {
                        break;
                    }
                    if (Buffer.byteLength(encoded, "utf8") > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES) {
                        console.warn("Live Session output exceeds the Relay frame limit", {
                            code: "live_event_too_large",
                            target: batch.target,
                        });
                        this.#pending.splice(this.#pending.indexOf(batch), 1);
                        this.#pendingBytes -= batch.bytes;
                        this.#sendingBatch = null;
                        continue;
                    }
                    if (socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") > MAX_BUFFERED_BYTES) {
                        socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event transport overloaded");
                        break;
                    }
                    socket.send(encoded);
                    this.#pending.splice(this.#pending.indexOf(batch), 1);
                    this.#pendingBytes -= batch.bytes;
                    this.#sendingBatch = null;
                }
            } catch (error) {
                if (!connection.controller.signal.aborted) {
                    console.warn("Live Session output could not be sent", { code: "live_event_send_failed", error });
                    socket.close(LOCAL_BACKPRESSURE_CLOSE_CODE, "Live event handoff failed");
                }
            } finally {
                this.#sendingBatch = null;
                if (this.#pending.length === 0) {
                    this.#overflowReported = false;
                }
            }
        })();
        this.#flushing = operation;
        void operation.finally(() => {
            if (this.#flushing === operation) {
                this.#flushing = null;
            }
            const current = this.#connection;
            if (current.kind === "connected" && this.#pending.some((batch) => current.isSubscribed(batch.target))) {
                this.flushEvents(current.socket);
            }
        });
    };
}
