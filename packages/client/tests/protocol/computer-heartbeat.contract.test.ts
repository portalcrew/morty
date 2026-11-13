import { expect, it } from "vitest";
import {
    COMPUTER_HEARTBEAT_ACK_MESSAGE,
    COMPUTER_HEARTBEAT_MESSAGE,
    decodeComputerHeartbeatAckEvent,
    decodeComputerHeartbeatEvent,
    decodeDaemonToRelayMessage,
    decodeRelayToDaemonMessage,
} from "../../src/protocol/index.ts";

it("Given fixed-text Computer heartbeats, When either peer decodes them, Then the heartbeat and acknowledgement remain supported", () => {
    expect(decodeDaemonToRelayMessage(COMPUTER_HEARTBEAT_MESSAGE)).toEqual({ kind: "computer.heartbeat" });
    expect(decodeRelayToDaemonMessage(COMPUTER_HEARTBEAT_ACK_MESSAGE)).toEqual({ kind: "computer.heartbeat.ack" });
});

it.each(["computer.heartbeat", "computer.heartbeat.ack"])(
    "Given a %s frame with unknown fields, When a peer decodes it, Then only its supported kind is retained",
    (kind) => {
        const encoded = JSON.stringify({ kind, extra: "ignored" });
        const decode = kind === "computer.heartbeat" ? decodeComputerHeartbeatEvent : decodeComputerHeartbeatAckEvent;
        expect(decode(encoded)).toEqual({ kind });
        if (kind === "computer.heartbeat") {
            expect(decodeDaemonToRelayMessage(encoded)).toEqual({ kind });
        } else {
            expect(decodeRelayToDaemonMessage(encoded)).toEqual({ kind });
        }
    },
);
