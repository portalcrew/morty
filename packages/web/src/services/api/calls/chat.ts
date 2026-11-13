import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type {
    NativeSessionRequest,
    NativeSessionTarget,
    SessionConfigurationSelection,
} from "@morty-build/client/protocol";
import type { ApiRequest, ComputerCallTarget } from "./call.ts";
import { type ComputerCallEncoding, encodeComputerCall } from "./encode-call.ts";

function encodeChatCall(input: ComputerCallEncoding): ApiRequest {
    return encodeComputerCall({
        ...input,
        path: `computers/${encodeURIComponent(input.computerId)}/${input.path}`,
    });
}

interface AgentDirectory {
    readonly harness: string;
    readonly directory: string;
}

export const chatCalls = Object.freeze({
    daemonDiagnostics: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "diagnostics/daemon",
            definition: {
                method: "POST",
                operation: "daemon-diagnostics",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "none",
            },
        }),
    networkDiagnostic: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "diagnostics/network",
            definition: {
                method: "POST",
                operation: "network-diagnostic",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "none",
            },
        }),
    createConversation: ({
        origin,
        computerId,
        input,
    }: ComputerCallTarget & {
        readonly input: {
            readonly harness: string;
            readonly configurations: readonly SessionConfigurationSelection[];
            readonly conversationKey: string;
            readonly workspaceRef: string;
        };
    }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "managed-sessions/open",
            definition: {
                method: "POST",
                operation: "access",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "none",
            },
            body: input,
        }),
    managedSessions: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "managed-sessions",
            definition: {
                method: "POST",
                operation: "managed-sessions",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "none",
            },
            body: {},
        }),
    archiveManagedSession: ({
        origin,
        computerId,
        target,
    }: ComputerCallTarget & { readonly target: NativeSessionTarget }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "managed-sessions/archive",
            definition: {
                method: "POST",
                operation: "managed-session/archive",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "none",
            },
            body: target,
        }),
    managedSession: ({
        origin,
        computerId,
        target,
    }: ComputerCallTarget & { readonly target: NativeSessionTarget }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "managed-sessions/resolve",
            definition: {
                method: "POST",
                operation: "managed-session",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "none",
            },
            body: target,
        }),
    continueNativeSession: ({
        origin,
        computerId,
        harness,
        sessionId,
    }: ComputerCallTarget & { readonly harness: string; readonly sessionId: string }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "native-sessions/continue",
            definition: {
                method: "POST",
                operation: "continue-native-session",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 120_000,
                watch: "none",
            },
            body: { harness, sessionId },
        }),
    agentSettings: ({
        origin,
        computerId,
        harness,
        workspaceRef,
    }: ComputerCallTarget & { readonly harness: string; readonly workspaceRef: string }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "agent-settings",
            definition: {
                method: "POST",
                operation: "agent-settings",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 120_000,
                watch: "none",
            },
            body: { harness, workspaceRef },
        }),
    computerConfiguration: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "workspace",
            definition: {
                method: "POST",
                operation: "workspace",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "snapshot",
            },
        }),
    directory: ({ origin, computerId, directory }: ComputerCallTarget & { readonly directory: string }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "workspace/directory",
            definition: {
                method: "POST",
                operation: "workspace/directory",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "none",
            },
            body: { directory },
        }),
    forkNativeSession: ({
        origin,
        computerId,
        operationId,
        input,
    }: ComputerCallTarget & {
        readonly operationId: string;
        readonly input: ForkMortyNativeSessionRequest;
    }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: `native-sessions/forks/${encodeURIComponent(operationId)}`,
            definition: {
                method: "POST",
                operation: "native-session-fork",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 120_000,
                watch: "none",
            },
            body: input,
        }),
    nativeSessions: ({
        origin,
        computerId,
        input,
    }: ComputerCallTarget & {
        readonly input: Omit<Extract<NativeSessionRequest, { readonly action: "list" }>, "kind" | "requestId">;
    }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "native-sessions",
            definition: {
                method: "POST",
                operation: "native-sessions",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 120_000,
                watch: "none",
            },
            body: input,
        }),
    importNativeSession: ({
        origin,
        computerId,
        sessionId,
        identity,
    }: ComputerCallTarget & { readonly sessionId: string; readonly identity: AgentDirectory }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: `native-sessions/${encodeURIComponent(sessionId)}/import`,
            definition: {
                method: "POST",
                operation: "native-session-import",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 120_000,
                watch: "none",
            },
            body: { harness: identity.harness, directory: identity.directory },
        }),
    nativeSession: ({
        origin,
        computerId,
        sessionId,
        identity,
    }: ComputerCallTarget & { readonly sessionId: string; readonly identity: AgentDirectory }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: `native-sessions/${encodeURIComponent(sessionId)}`,
            definition: {
                method: "POST",
                operation: "native-session",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 120_000,
                watch: "none",
            },
            body: identity,
        }),
    sessionAccess: ({
        origin,
        computerId,
        target,
    }: ComputerCallTarget & { readonly target: NativeSessionTarget }): ApiRequest =>
        encodeChatCall({
            origin,
            computerId,
            path: "native-sessions/access",
            definition: {
                method: "POST",
                operation: "session-access",
                transport: { kind: "websocket", cancellation: "remote" },
                timeoutMilliseconds: 45_000,
                watch: "none",
            },
            body: target,
        }),
});
