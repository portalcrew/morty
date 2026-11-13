import type { PayloadDecryptor } from "@morty-build/client";
import {
    COMPUTER_HEARTBEAT_ACK_KIND,
    COMPUTER_LIVENESS_READY_KIND,
    contentChunkCodec,
    decodeEncryptedDaemonInboundMessage,
    decodeRelayToDaemonMessage,
    type NativeSessionTarget,
    SESSION_EVENTS_UNSUBSCRIBE_KIND,
    sessionOperationFailedEventCodec,
    WORKER_REQUEST_CANCEL_KIND,
} from "@morty-build/client/protocol";
import { WebSocket } from "undici";

import { operationErrorCode, operationErrorMessage } from "../../infra/operation-error.ts";
import type { DurationMetric } from "../../infra/operation-metrics.ts";
import type { CommandContext } from "./context.ts";
import type { DaemonCommand } from "./definition.ts";

/** Validates routing before decoding a client command or a Worker-owned control. */
export async function receive(
    encoded: string,
    encryption: PayloadDecryptor,
    signal: AbortSignal,
): Promise<DaemonCommand> {
    signal.throwIfAborted();
    const routing = decodeRelayToDaemonMessage(encoded);
    if (routing.kind === SESSION_EVENTS_UNSUBSCRIBE_KIND || routing.kind === WORKER_REQUEST_CANCEL_KIND) {
        return routing;
    }
    if (routing.kind === COMPUTER_HEARTBEAT_ACK_KIND || routing.kind === COMPUTER_LIVENESS_READY_KIND) {
        throw new Error("Unexpected connection control");
    }
    const message = await decodeEncryptedDaemonInboundMessage(encoded, encryption, signal);
    signal.throwIfAborted();
    return message;
}

export function send(socket: WebSocket, encoded: string | Uint8Array): void {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not open");
    }
    socket.send(encoded);
}

export async function sendContentChunk(
    { socket, payloadEncryption }: Pick<CommandContext, "socket" | "payloadEncryption">,
    requestId: string,
    sequence: number,
    bytes: Uint8Array,
    signal: AbortSignal,
): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection is not open");
    }
    send(socket, await contentChunkCodec.encode({ requestId, sequence, bytes }, payloadEncryption, signal));
}

export async function reportOperationFailure(
    { socket, payloadEncryption, signal }: Pick<CommandContext, "socket" | "payloadEncryption" | "signal">,
    requestId: string,
    target: NativeSessionTarget | undefined,
    error: unknown,
    runtimeTimings: readonly DurationMetric[] = [],
): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
        return;
    }
    const encoded = await sessionOperationFailedEventCodec.encode(
        {
            code: operationErrorCode(error),
            kind: "session.operation.failed",
            message: operationErrorMessage(error),
            requestId,
            ...(runtimeTimings.length === 0 ? {} : { runtimeTimings }),
            ...(target === undefined ? {} : { target }),
        },
        payloadEncryption,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
    if (socket.readyState === WebSocket.OPEN) {
        send(socket, encoded);
    }
}
