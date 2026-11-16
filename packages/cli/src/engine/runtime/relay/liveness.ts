import { COMPUTER_HEARTBEAT_KIND, type ComputerHeartbeatEvent } from "@portalcrew/morty-client/protocol";

import type { ScheduledTask, Timer } from "../../util/timer.ts";

export const HEARTBEAT_ACK_TIMEOUT_MILLISECONDS = 10_000;
export const HEARTBEAT_INTERVAL_MILLISECONDS = 20_000;

abstract class RelayLivenessState {}

class NotStartedRelayLivenessState extends RelayLivenessState {}

// Heartbeats carry no identifier so the Relay's host can answer them without waking the Relay.
// At most one is unacknowledged, so the next acknowledgement always answers it.
class AwaitingHeartbeatAckState extends RelayLivenessState {
    readonly timeout: ScheduledTask;

    constructor(timeout: ScheduledTask) {
        super();
        this.timeout = timeout;
    }
}

class WaitingForHeartbeatState extends RelayLivenessState {
    readonly schedule: ScheduledTask;

    constructor(schedule: ScheduledTask) {
        super();
        this.schedule = schedule;
    }
}

class FinishedRelayLivenessState extends RelayLivenessState {}

export interface RelayLivenessTransport {
    readonly send: (message: ComputerHeartbeatEvent) => boolean;
    readonly unresponsive: (timeoutMilliseconds: number) => void;
}

export class RelayConnectionLiveness {
    readonly #timer: Timer;
    readonly #transport: RelayLivenessTransport;
    #state: RelayLivenessState = new NotStartedRelayLivenessState();

    constructor(timer: Timer, transport: RelayLivenessTransport) {
        this.#timer = timer;
        this.#transport = transport;
    }

    readonly acknowledge = (): void => {
        if (!(this.#state instanceof AwaitingHeartbeatAckState)) {
            throw new Error("Unexpected relay heartbeat acknowledgement");
        }
        this.#state.timeout.cancel();
        this.#state = new WaitingForHeartbeatState(
            this.#timer.schedule(this.#sendHeartbeat, HEARTBEAT_INTERVAL_MILLISECONDS),
        );
    };

    readonly close = (): void => {
        if (this.#state instanceof AwaitingHeartbeatAckState) {
            this.#state.timeout.cancel();
        } else if (this.#state instanceof WaitingForHeartbeatState) {
            this.#state.schedule.cancel();
        } else if (
            !(this.#state instanceof NotStartedRelayLivenessState) &&
            !(this.#state instanceof FinishedRelayLivenessState)
        ) {
            throw new Error("Unknown relay liveness state");
        }
        this.#state = new FinishedRelayLivenessState();
    };

    readonly start = (): void => {
        if (this.#state instanceof NotStartedRelayLivenessState) {
            this.#sendHeartbeat();
            return;
        }
        if (this.#state instanceof AwaitingHeartbeatAckState || this.#state instanceof WaitingForHeartbeatState) {
            return;
        }
        if (this.#state instanceof FinishedRelayLivenessState) {
            return;
        }
        throw new Error("Unknown relay liveness state");
    };

    readonly #handleTimeout = (): void => {
        if (this.#state instanceof FinishedRelayLivenessState) {
            return;
        }
        if (!(this.#state instanceof AwaitingHeartbeatAckState)) {
            throw new Error("Heartbeat timeout occurred in an invalid state");
        }
        this.#state.timeout.cancel();
        this.#state = new FinishedRelayLivenessState();
        this.#transport.unresponsive(HEARTBEAT_ACK_TIMEOUT_MILLISECONDS);
    };

    readonly #sendHeartbeat = (): void => {
        if (this.#state instanceof WaitingForHeartbeatState) {
            this.#state.schedule.cancel();
        } else if (!(this.#state instanceof NotStartedRelayLivenessState)) {
            if (this.#state instanceof FinishedRelayLivenessState) {
                return;
            }
            throw new Error("Heartbeat was scheduled in an invalid state");
        }
        const awaiting = new AwaitingHeartbeatAckState(
            this.#timer.schedule(this.#handleTimeout, HEARTBEAT_ACK_TIMEOUT_MILLISECONDS),
        );
        this.#state = awaiting;
        const sent = this.#transport.send({ kind: COMPUTER_HEARTBEAT_KIND });
        if (!sent && this.#state === awaiting) {
            awaiting.timeout.cancel();
            this.#state = new FinishedRelayLivenessState();
        }
    };
}
