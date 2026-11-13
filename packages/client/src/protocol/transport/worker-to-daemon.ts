import {
    COMPUTER_HEARTBEAT_ACK_KIND,
    COMPUTER_LIVENESS_READY_KIND,
    decodeComputerHeartbeatAckEvent,
    decodeComputerLivenessReadyEvent,
} from "../computer/liveness.ts";
import { decodeWorkerRequestCancel, WORKER_REQUEST_CANCEL_KIND } from "../relay/request-cancellation.ts";
import { decodeSessionEventsUnsubscribe, SESSION_EVENTS_UNSUBSCRIBE_KIND } from "../session/events/index.ts";
import { decodeMessageKind, ProtocolMessageError } from "../shared/message-codec.ts";

const workerToDaemonDecoders = {
    [COMPUTER_HEARTBEAT_ACK_KIND]: decodeComputerHeartbeatAckEvent,
    [COMPUTER_LIVENESS_READY_KIND]: decodeComputerLivenessReadyEvent,
    [SESSION_EVENTS_UNSUBSCRIBE_KIND]: decodeSessionEventsUnsubscribe,
    [WORKER_REQUEST_CANCEL_KIND]: decodeWorkerRequestCancel,
} as const;
export type WorkerToDaemonMessage = ReturnType<(typeof workerToDaemonDecoders)[keyof typeof workerToDaemonDecoders]>;
export function decodeWorkerToDaemonMessage(encoded: string): WorkerToDaemonMessage {
    const registry: Readonly<Record<string, (value: string) => WorkerToDaemonMessage>> = workerToDaemonDecoders;
    const decoder = registry[decodeMessageKind(encoded)];
    if (decoder === undefined) {
        throw new ProtocolMessageError("Unknown Worker-to-daemon control kind");
    }
    return decoder(encoded);
}
