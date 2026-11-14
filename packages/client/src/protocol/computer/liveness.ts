import { z as routingZ } from "zod";
import { encryptedMessageCodec } from "../shared/encrypted-message.ts";
import { identifierStringSchema as routingIdentifier } from "../shared/identifier.ts";
import {
    assertKind,
    decodeZodMessage as decodeRoutingZodMessage,
    encryptedFieldSchema,
    parseJson,
    readIdentifier,
} from "../shared/message-codec.ts";

export const COMPUTER_LIVENESS_READY_KIND = "computer.liveness.ready";
export const COMPUTER_HEARTBEAT_KIND = "computer.heartbeat";
export const COMPUTER_HEARTBEAT_ACK_KIND = "computer.heartbeat.ack";
export const COMPUTER_PING_KIND = "computer.ping";
export const COMPUTER_PONG_KIND = "computer.pong";

/**
 * The Relay's host answers this exact text without waking the Relay, so a heartbeat and its
 * acknowledgement carry no per-heartbeat data and must keep this byte-for-byte encoding.
 */
export const COMPUTER_HEARTBEAT_MESSAGE = `{"kind":"${COMPUTER_HEARTBEAT_KIND}"}`;
export const COMPUTER_HEARTBEAT_ACK_MESSAGE = `{"kind":"${COMPUTER_HEARTBEAT_ACK_KIND}"}`;

export interface ComputerLivenessReadyEvent {
    readonly kind: typeof COMPUTER_LIVENESS_READY_KIND;
}

export interface ComputerHeartbeatEvent {
    readonly kind: typeof COMPUTER_HEARTBEAT_KIND;
}

export interface ComputerHeartbeatAckEvent {
    readonly kind: typeof COMPUTER_HEARTBEAT_ACK_KIND;
}

interface ComputerPingCommand {
    readonly kind: typeof COMPUTER_PING_KIND;
    readonly requestId: string;
}

interface ComputerPongEvent {
    readonly kind: typeof COMPUTER_PONG_KIND;
    readonly requestId: string;
}

export function decodeComputerLivenessReadyEvent(encoded: string): ComputerLivenessReadyEvent {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_LIVENESS_READY_KIND);
    return { kind: COMPUTER_LIVENESS_READY_KIND };
}

export function decodeComputerHeartbeatEvent(encoded: string): ComputerHeartbeatEvent {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_HEARTBEAT_KIND);
    return { kind: COMPUTER_HEARTBEAT_KIND };
}

export function decodeComputerHeartbeatAckEvent(encoded: string): ComputerHeartbeatAckEvent {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_HEARTBEAT_ACK_KIND);
    return { kind: COMPUTER_HEARTBEAT_ACK_KIND };
}

function decodeComputerPingCommand(encoded: string): ComputerPingCommand {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_PING_KIND);
    return { kind: COMPUTER_PING_KIND, requestId: readIdentifier(value, "requestId") };
}

function decodeComputerPongEvent(encoded: string): ComputerPongEvent {
    const value = parseJson(encoded);
    assertKind(value, COMPUTER_PONG_KIND);
    return { kind: COMPUTER_PONG_KIND, requestId: readIdentifier(value, "requestId") };
}

export function encodeComputerLivenessReadyEvent(message: ComputerLivenessReadyEvent): string {
    return JSON.stringify(decodeComputerLivenessReadyEvent(JSON.stringify(message)));
}

const computerPingCommandPublicRoutingSchema = routingZ.object({
    kind: routingZ.literal(COMPUTER_PING_KIND),
    requestId: routingIdentifier,
});
const computerPingCommandRoutingSchema = computerPingCommandPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
export type ComputerPingCommandRouting = routingZ.infer<typeof computerPingCommandRoutingSchema>;
const decodeComputerPingCommandRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, computerPingCommandRoutingSchema);
export const computerPingCommandCodec = encryptedMessageCodec({
    kind: COMPUTER_PING_KIND,
    decode: decodeComputerPingCommand,
    decodeRouting: decodeComputerPingCommandRouting,
    publicRoutingSchema: computerPingCommandPublicRoutingSchema,
});

const computerPongEventPublicRoutingSchema = routingZ.object({
    kind: routingZ.literal(COMPUTER_PONG_KIND),
    requestId: routingIdentifier,
});
const computerPongEventRoutingSchema = computerPongEventPublicRoutingSchema
    .extend({ encrypted: encryptedFieldSchema })
    .strict();
const decodeComputerPongEventRouting = (encoded: string) =>
    decodeRoutingZodMessage(encoded, computerPongEventRoutingSchema);
export const computerPongEventCodec = encryptedMessageCodec({
    kind: COMPUTER_PONG_KIND,
    decode: decodeComputerPongEvent,
    decodeRouting: decodeComputerPongEventRouting,
    publicRoutingSchema: computerPongEventPublicRoutingSchema,
});
