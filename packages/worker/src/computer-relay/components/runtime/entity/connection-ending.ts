import type { ComputerConnectionIdentity } from "./computer-connection.ts";

/** Why the Relay closes a daemon connection. The close frame and the record of it both derive from this one value. */
export type DaemonConnectionEnding =
    | { readonly kind: "replaced"; readonly replacement: ComputerConnectionIdentity | null }
    | { readonly kind: "pairing_replaced"; readonly replacement: ComputerConnectionIdentity }
    | { readonly kind: "revoked" }
    | { readonly kind: "heartbeat_silence"; readonly silenceMilliseconds: number }
    | { readonly kind: "attachment_failed" }
    | { readonly kind: "authorization_unavailable" }
    | { readonly kind: "message_queue_full"; readonly code: string }
    | { readonly kind: "invalid_content_chunk"; readonly overCapacity: boolean }
    | { readonly kind: "oversized_message" };

/** Why the Relay ends every open Session subscription at once, naming the daemon connection that caused it. */
export type SessionViewersEnding =
    | { readonly kind: "daemon_replaced"; readonly replacement: ComputerConnectionIdentity }
    | { readonly kind: "pairing_replaced"; readonly replacement: ComputerConnectionIdentity }
    | { readonly kind: "computer_offline"; readonly connection: ComputerConnectionIdentity }
    | { readonly kind: "computer_revoked"; readonly connection: ComputerConnectionIdentity | null };

interface CloseFrame {
    readonly code: number;
    readonly reason: string;
}

// The daemon recognizes revocation by these exact frames.
export function daemonCloseFrame(ending: DaemonConnectionEnding): CloseFrame {
    switch (ending.kind) {
        case "replaced":
            return { code: 1012, reason: "Daemon connection replaced" };
        case "pairing_replaced":
            return { code: 1000, reason: "Previous daemon disconnected" };
        case "revoked":
            return { code: 1008, reason: "Computer revoked" };
        case "heartbeat_silence":
            return { code: 4001, reason: "Computer heartbeat timed out" };
        case "attachment_failed":
            return { code: 1011, reason: "Computer attachment failed" };
        case "authorization_unavailable":
            return { code: 1011, reason: "Computer authorization unavailable" };
        case "message_queue_full":
            return { code: 1013, reason: ending.code };
        case "invalid_content_chunk":
            return { code: ending.overCapacity ? 1013 : 1008, reason: "Invalid content chunk" };
        case "oversized_message":
            return { code: 1003, reason: "Bounded text message required" };
        default:
            return ending satisfies never;
    }
}

export function sessionViewersCloseFrame(ending: SessionViewersEnding): CloseFrame {
    switch (ending.kind) {
        case "daemon_replaced":
            return { code: 1012, reason: "Daemon connection replaced" };
        case "pairing_replaced":
            return { code: 1000, reason: "Previous daemon disconnected" };
        case "computer_offline":
            return { code: 1000, reason: "Computer offline" };
        case "computer_revoked":
            return { code: 1008, reason: "Computer revoked" };
        default:
            return ending satisfies never;
    }
}

export function daemonEndingLogFields(ending: DaemonConnectionEnding): Readonly<Record<string, number | string>> {
    switch (ending.kind) {
        case "replaced":
            return ending.replacement === null
                ? { reason: ending.kind }
                : { reason: ending.kind, replacementConnectionEpoch: ending.replacement.connectionEpoch };
        case "pairing_replaced":
            return { reason: ending.kind, replacementConnectionEpoch: ending.replacement.connectionEpoch };
        case "heartbeat_silence":
            return { reason: ending.kind, silenceMilliseconds: ending.silenceMilliseconds };
        case "revoked":
        case "attachment_failed":
        case "authorization_unavailable":
        case "message_queue_full":
        case "invalid_content_chunk":
        case "oversized_message":
            return { reason: ending.kind };
        default:
            return ending satisfies never;
    }
}

export function sessionViewersEndingLogFields(ending: SessionViewersEnding): Readonly<Record<string, number | string>> {
    switch (ending.kind) {
        case "daemon_replaced":
        case "pairing_replaced":
            return { reason: ending.kind, replacementConnectionEpoch: ending.replacement.connectionEpoch };
        case "computer_offline":
            return { reason: ending.kind, connectionEpoch: ending.connection.connectionEpoch };
        case "computer_revoked":
            return ending.connection === null
                ? { reason: ending.kind }
                : { reason: ending.kind, connectionEpoch: ending.connection.connectionEpoch };
        default:
            return ending satisfies never;
    }
}

/** An expected ending is the Relay's ordinary bookkeeping; any other is worth a warning. */
export function isExpectedDaemonEnding(ending: DaemonConnectionEnding): boolean {
    return ending.kind === "replaced" || ending.kind === "pairing_replaced" || ending.kind === "revoked";
}
