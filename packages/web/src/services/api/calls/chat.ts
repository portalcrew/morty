import type { ForkMortyNativeSessionRequest } from "@morty-build/client";
import type {
    NativeSessionRequest,
    NativeSessionTarget,
    SessionConfigurationSelection,
} from "@morty-build/client/protocol";
import type { ApiRequest, ComputerCallTarget } from "./call.ts";
import { encodeComputerCall } from "./encode-call.ts";

interface AgentDirectory {
    readonly harness: string;
    readonly directory: string;
}

export const chatCalls = Object.freeze({
    verifyAgent: ({ origin, computerId, harness }: ComputerCallTarget & { readonly harness: string }): ApiRequest =>
        encodeComputerCall({
            origin,
            computerId,
            path: "setup",
            definition: {
                method: "POST",
                operation: "verify-agent",
                transport: { kind: "http" },
                timeoutMilliseconds: 120_000,
                watch: "none",
            },
            body: { kind: "agent.settings.discover", requestId: crypto.randomUUID(), harness, directory: "." },
        }),
    daemonDiagnostics: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeComputerCall({
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
            body: { kind: "computer.diagnostics.read", requestId: crypto.randomUUID() },
        }),
    networkDiagnostic: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeComputerCall({
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
            body: { kind: "computer.ping", requestId: `ping_${crypto.randomUUID()}` },
        }),
    createConversation: ({
        origin,
        computerId,
        input,
    }: ComputerCallTarget & {
        readonly input: {
            readonly harness: string;
            readonly configurations: readonly SessionConfigurationSelection[];
            readonly operationId: string;
            readonly workspaceRef: string;
        };
    }): ApiRequest =>
        encodeComputerCall({
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
            body: {
                kind: "session.create",
                requestId: crypto.randomUUID(),
                operationId: input.operationId,
                harness: input.harness,
                configurations: input.configurations,
                directory: input.workspaceRef,
            },
        }),
    managedSessions: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeComputerCall({
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
            body: { kind: "session.list", requestId: crypto.randomUUID(), limit: 500 },
        }),
    archiveManagedSession: ({
        origin,
        computerId,
        target,
    }: ComputerCallTarget & { readonly target: NativeSessionTarget }): ApiRequest =>
        encodeComputerCall({
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
            body: { kind: "session.archive", requestId: crypto.randomUUID(), target },
        }),
    managedSession: ({
        origin,
        computerId,
        target,
    }: ComputerCallTarget & { readonly target: NativeSessionTarget }): ApiRequest =>
        encodeComputerCall({
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
            body: { kind: "session.restore", requestId: crypto.randomUUID(), target },
        }),
    continueNativeSession: ({
        origin,
        computerId,
        harness,
        sessionId,
        action,
        directory,
    }: ComputerCallTarget & {
        readonly harness: string;
        readonly sessionId: string;
        readonly action: "find" | "import";
        readonly directory: string;
    }): ApiRequest =>
        encodeComputerCall({
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
            body: {
                kind: "native.session.request",
                requestId: crypto.randomUUID(),
                action,
                harness,
                sessionId,
                directory,
            },
        }),
    agentSettings: ({
        origin,
        computerId,
        harness,
        workspaceRef,
    }: ComputerCallTarget & { readonly harness: string; readonly workspaceRef: string }): ApiRequest =>
        encodeComputerCall({
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
            body: { kind: "agent.settings.discover", requestId: crypto.randomUUID(), harness, directory: workspaceRef },
        }),
    computerConfiguration: ({ origin, computerId }: ComputerCallTarget): ApiRequest =>
        encodeComputerCall({
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
        encodeComputerCall({
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
            body: { kind: "workspace.list", requestId: crypto.randomUUID(), directory },
        }),
    forkNativeSession: ({
        origin,
        computerId,
        operationId,
        requestId,
        input,
    }: ComputerCallTarget & {
        readonly operationId: string;
        readonly requestId: string;
        readonly input: ForkMortyNativeSessionRequest;
    }): ApiRequest =>
        encodeComputerCall({
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
            body: { ...input, kind: "native.session.request", action: "fork", requestId },
        }),
    nativeSessions: ({
        origin,
        computerId,
        input,
    }: ComputerCallTarget & {
        readonly input: Omit<Extract<NativeSessionRequest, { readonly action: "list" }>, "kind" | "requestId">;
    }): ApiRequest =>
        encodeComputerCall({
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
            body: { ...input, kind: "native.session.request", requestId: crypto.randomUUID() },
        }),
    importNativeSession: ({
        origin,
        computerId,
        sessionId,
        identity,
    }: ComputerCallTarget & { readonly sessionId: string; readonly identity: AgentDirectory }): ApiRequest =>
        encodeComputerCall({
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
            body: {
                ...identity,
                kind: "native.session.request",
                action: "import",
                requestId: crypto.randomUUID(),
                sessionId,
            },
        }),
    nativeSession: ({
        origin,
        computerId,
        sessionId,
        identity,
    }: ComputerCallTarget & { readonly sessionId: string; readonly identity: AgentDirectory }): ApiRequest =>
        encodeComputerCall({
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
            body: {
                kind: "session.preview-history.page.load",
                requestId: crypto.randomUUID(),
                target: { harness: identity.harness, sessionId },
                directory: identity.directory,
                cursor: null,
                eventLimit: 200,
            },
        }),
    sessionAccess: ({
        origin,
        computerId,
        target,
    }: ComputerCallTarget & { readonly target: NativeSessionTarget }): ApiRequest =>
        encodeComputerCall({
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
            body: { kind: "session.prepare", requestId: crypto.randomUUID(), target },
        }),
});
