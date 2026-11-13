import { COMPUTER_HEARTBEAT_ACK_KIND, COMPUTER_LIVENESS_READY_KIND } from "../computer/liveness.ts";
import { WORKER_REQUEST_CANCEL_KIND } from "../relay/request-cancellation.ts";
import { SESSION_EVENTS_UNSUBSCRIBE_KIND } from "../session/events/index.ts";
import { decodeMessageKind } from "../shared/message-codec.ts";
import { type ClientToRelayMessage, decodeClientToRelayMessage } from "./client-to-relay.ts";
import { decodeWorkerToDaemonMessage, type WorkerToDaemonMessage } from "./worker-to-daemon.ts";

export type RelayToDaemonMessage = ClientToRelayMessage | WorkerToDaemonMessage;

export function decodeRelayToDaemonMessage(encoded: string): RelayToDaemonMessage {
    switch (decodeMessageKind(encoded)) {
        case COMPUTER_HEARTBEAT_ACK_KIND:
        case COMPUTER_LIVENESS_READY_KIND:
        case SESSION_EVENTS_UNSUBSCRIBE_KIND:
        case WORKER_REQUEST_CANCEL_KIND:
            return decodeWorkerToDaemonMessage(encoded);
        default:
            return decodeClientToRelayMessage(encoded);
    }
}
