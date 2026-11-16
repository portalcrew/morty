import { isIdentifier } from "@portalcrew/morty-client/protocol";
import { MortyValidationError } from "../errors.ts";
import type { MortyOperationEndpoint, MortyTransportPolicy } from "./call.ts";

export interface ComputerCallTarget {
    readonly computerId: string;
}

const computerControl: MortyTransportPolicy = { kind: "websocket", cancellation: "remote" };

function identifierSegment(value: string): string {
    if (!isIdentifier(value)) {
        throw new MortyValidationError("The Morty identifier is invalid");
    }
    return encodeURIComponent(value);
}

function endpoint({
    computerId,
    operation,
    path,
    transport = computerControl,
    timeoutMilliseconds,
}: ComputerCallTarget & {
    readonly operation: string;
    readonly path: string;
    readonly transport?: MortyTransportPolicy;
    readonly timeoutMilliseconds: number;
}): MortyOperationEndpoint {
    if (!isIdentifier(computerId)) {
        throw new MortyValidationError("The Morty Computer identifier is invalid");
    }
    return {
        computerId,
        operation,
        method: "POST",
        path: `v1/computers/${encodeURIComponent(computerId)}/${path}`,
        transport,
        timeoutMilliseconds,
    };
}

export const computerEndpoints = Object.freeze({
    verifyAgent: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "verify-agent",
            path: "setup",
            transport: { kind: "http" },
            timeoutMilliseconds: 120_000,
        }),
    discoverAgentSettings: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({ computerId, operation: "agent-settings", path: "agent-settings", timeoutMilliseconds: 120_000 }),
    readDiagnostics: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "daemon-diagnostics",
            path: "diagnostics/daemon",
            timeoutMilliseconds: 45_000,
        }),
    measureLatency: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "network-diagnostic",
            path: "diagnostics/network",
            timeoutMilliseconds: 45_000,
        }),
    createSession: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "session-create",
            path: "managed-sessions/open",
            timeoutMilliseconds: 45_000,
        }),
    listSessions: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({ computerId, operation: "managed-sessions", path: "managed-sessions", timeoutMilliseconds: 45_000 }),
    archiveSession: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "managed-session-archive",
            path: "managed-sessions/archive",
            timeoutMilliseconds: 45_000,
        }),
    restoreSession: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "managed-session-restore",
            path: "managed-sessions/resolve",
            timeoutMilliseconds: 45_000,
        }),
    prepareSession: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "session-access",
            path: "native-sessions/access",
            timeoutMilliseconds: 45_000,
        }),
    listDirectory: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "workspace-directory",
            path: "workspace/directory",
            timeoutMilliseconds: 45_000,
        }),
    listNativeSessions: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({ computerId, operation: "native-sessions", path: "native-sessions", timeoutMilliseconds: 120_000 }),
    continueNativeSession: ({ computerId }: ComputerCallTarget): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "native-session-continue",
            path: "native-sessions/continue",
            timeoutMilliseconds: 120_000,
        }),
    forkNativeSession: ({
        computerId,
        operationId,
    }: ComputerCallTarget & { readonly operationId: string }): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "native-session-fork",
            path: `native-sessions/forks/${identifierSegment(operationId)}`,
            timeoutMilliseconds: 120_000,
        }),
    previewNativeSession: ({
        computerId,
        sessionId,
    }: ComputerCallTarget & { readonly sessionId: string }): MortyOperationEndpoint =>
        endpoint({
            computerId,
            operation: "native-session-preview",
            path: `native-sessions/${identifierSegment(sessionId)}`,
            timeoutMilliseconds: 120_000,
        }),
});
