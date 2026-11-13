import type {
    NativeSessionTarget,
    SessionConfigReadCommand,
    SessionConfigurationSelection,
    SessionConfigureCommand,
    SessionCreateCommand,
    SessionPrepareCommand,
    SessionReadyEvent,
    SessionRenameCommand,
    SessionRestoreCommand,
    WorkspaceListCommand,
} from "@morty-build/client/protocol";
import {
    type SESSION_CONFIG_READ_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
    type SESSION_CONFIGURE_KIND,
    type SESSION_CREATE_KIND,
    type SESSION_PREPARE_KIND,
    type SESSION_RENAME_KIND,
    type SESSION_RESTORE_KIND,
    sessionConfigurationSelection,
    type WORKSPACE_LIST_KIND,
} from "@morty-build/client/protocol";
import type { WebSocket } from "undici";
import { operationErrorCode } from "../../../infra/operation-error.ts";
import { AccumulatingOperationMetrics } from "../../../infra/operation-metrics.ts";
import type { PreparedSession, ResolveAgent, SessionRecovery } from "../../../session/api/session-api.ts";
import { SessionError } from "../../../session/api/session-error.ts";
import type { SessionManager } from "../../../session/manager/session-manager.ts";
import type { NativeSessionService } from "../../../session/native/native-session-browser.ts";
import { applyCompleteSessionConfiguration } from "../../../session/prompt/apply-session-configuration.ts";
import { type HeldSession, resolveHeldSession } from "../../../session/record/held-session.ts";
import { resolveSessionDirectory } from "../../../session/workspace/resolve-session-directory.ts";
import type { WorkspaceDirectoryService } from "../../../session/workspace/workspace-directory.ts";
import type { RelayConnectionDiagnostics } from "../../relay/diagnostics.ts";
import type { CommandContext } from "../context.ts";
import type { CommandHandler } from "../definition.ts";
import { reportOperationFailure, send } from "../transport.ts";

/** What a preparation of a Session asks for, apart from the Session itself. */
interface SessionPreparationRequest {
    readonly requestId: string;
    /** The complete settings a Session being created starts with. */
    readonly configurations?: readonly SessionConfigurationSelection[] | undefined;
}

/** Resolves the Session this Computer holds for `target`, measured as part of the preparation. */
const resolveMeasuredHeldSession = async (
    target: NativeSessionTarget,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    metrics: AccumulatingOperationMetrics,
    signal: AbortSignal,
): Promise<HeldSession> =>
    await metrics.measure(
        "workspace-resolve",
        async () => await resolveHeldSession(sessions, resolveAgent, directories, target, signal),
    );

async function prepareSession(
    command: SessionPreparationRequest,
    session: HeldSession,
    recovery: SessionRecovery,
    sessions: SessionManager,
    metrics: AccumulatingOperationMetrics,
): Promise<SessionReadyEvent> {
    return await metrics.measure("prepare-total", async () => {
        const preparation = session.options;
        const { target } = preparation;
        const prepare = async (): Promise<PreparedSession> => {
            if (recovery.kind === "history-required") {
                return await sessions.restoreSession(preparation, metrics);
            }
            const configurations = command.configurations;
            if (configurations === undefined) {
                return await sessions.prepareSession(preparation, metrics);
            }
            // A Session being created starts with exactly the settings it states, by the rule a Turn's settings use.
            return await sessions.createSession(
                preparation,
                async (created, creationSignal) =>
                    await metrics.measure(
                        "configuration",
                        async () =>
                            await applyCompleteSessionConfiguration(
                                sessions,
                                created.configOptions,
                                configurations,
                                "refuse",
                                preparation.agent,
                                preparation.adapter,
                                preparation.cwd,
                                command.requestId,
                                target,
                                creationSignal,
                            ),
                    ),
                metrics,
            );
        };
        const prepared = await prepare();
        return {
            harness: target.harness,
            agentName: prepared.agentName,
            agentVersion: prepared.agentVersion,
            capabilities: prepared.capabilities,
            commands: prepared.commands,
            configOptions: prepared.configOptions,
            configurationRevision: prepared.configurationRevision,
            directory: session.directory,
            directoryLabel: session.directoryLabel,
            kind: "session.ready",
            requestId: command.requestId,
            restored: prepared.restored,
            target,
        };
    });
}

async function executeWorkspaceList(
    socket: WebSocket,
    command: WorkspaceListCommand,
    directories: WorkspaceDirectoryService,
    signal: AbortSignal,
): Promise<void> {
    try {
        const listing =
            command.view === "metadata"
                ? await directories.describe(command.directory, signal).then((directory) => ({
                      directory: command.directory,
                      directoryLabel: directory.label,
                      entries: [],
                      parentDirectory: directory.parentDirectory,
                  }))
                : await directories.list(command.directory, signal);
        send(socket, {
            directory: listing.directory,
            directoryLabel: listing.directoryLabel,
            entries: listing.entries,
            kind: "workspace.entries",
            parentDirectory: listing.parentDirectory,
            requestId: command.requestId,
        });
    } catch (error) {
        reportOperationFailure(socket, command.requestId, undefined, error);
    }
}

async function executeSessionPrepare(
    socket: WebSocket,
    command: SessionPrepareCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const metrics = new AccumulatingOperationMetrics();
    try {
        const readyEvent = await prepareSession(
            command,
            await resolveMeasuredHeldSession(command.target, resolveAgent, directories, sessions, metrics, signal),
            { kind: "interactive-only" },
            sessions,
            metrics,
        );
        send(socket, {
            ...readyEvent,
            runtimeTimings: metrics.snapshot(),
        });
    } catch (error) {
        diagnostics.daemonDiagnostic(
            "session_prepare_failed",
            command.requestId,
            {
                harness: command.target.harness,
                code: operationErrorCode(error),
                sessionId: command.target.sessionId,
            },
            error,
        );
        reportOperationFailure(socket, command.requestId, command.target, error, metrics.snapshot());
    }
}

async function executeSessionRestore(
    socket: WebSocket,
    command: SessionRestoreCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    nativeSessions: NativeSessionService,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const metrics = new AccumulatingOperationMetrics();
    try {
        const entry = await metrics.measure("session-lookup", async () => {
            const stored = sessions.findSessions([command.target])[0];
            const [found] = await nativeSessions.querySessions(stored === undefined ? [] : [stored.target], signal);
            if (found === undefined) {
                throw new SessionError("session_not_found", "The Session was not found");
            }
            return found;
        });
        const ready = await prepareSession(
            command,
            await resolveMeasuredHeldSession(entry.target, resolveAgent, directories, sessions, metrics, signal),
            { kind: "history-required" },
            sessions,
            metrics,
        );
        send(socket, {
            entry,
            target: command.target,
            kind: "session.restored",
            ready: { ...ready, runtimeTimings: metrics.snapshot() },
            requestId: command.requestId,
        });
    } catch (error) {
        diagnostics.daemonDiagnostic(
            "session_restore_failed",
            command.requestId,
            {
                code: operationErrorCode(error),
                harness: command.target.harness,
                sessionId: command.target.sessionId,
            },
            error,
        );
        reportOperationFailure(socket, command.requestId, undefined, error, metrics.snapshot());
    }
}

async function executeSessionRename(
    socket: WebSocket,
    command: SessionRenameCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    nativeSessions: NativeSessionService,
    signal: AbortSignal,
): Promise<void> {
    try {
        const [entry] = await nativeSessions.querySessions([command.target], signal);
        if (entry === undefined) {
            throw new SessionError("session_not_found", "The Session was not found");
        }
        const resolved = await resolveSessionDirectory(directories, entry.directory, signal);
        const renamed = await sessions.renameSession(
            {
                ...(await resolveAgent(entry.harness, signal)),
                cwd: resolved.cwd,
                target: command.target,
                signal,
            },
            command.title,
        );
        send(socket, {
            kind: "session.renamed",
            requestId: command.requestId,
            target: command.target,
            title: renamed.title,
            updatedAt: renamed.updatedAt,
        });
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        reportOperationFailure(socket, command.requestId, command.target, error);
    }
}

async function executeSessionConfigure(
    socket: WebSocket,
    command: SessionConfigureCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    signal: AbortSignal,
): Promise<void> {
    try {
        const session = await resolveHeldSession(sessions, resolveAgent, directories, command.target, signal);
        const snapshot = await sessions.configureSession({
            ...session.options,
            ...sessionConfigurationSelection(command),
            expectedConfigurationRevision: command.expectedConfigurationRevision,
            requestId: command.requestId,
        });
        send(socket, {
            ...snapshot,
            kind: "session.config.updated",
            requestId: command.requestId,
            target: command.target,
        });
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        reportOperationFailure(socket, command.requestId, command.target, error);
    }
}

export const handleWorkspaceList: CommandHandler<typeof WORKSPACE_LIST_KIND> = (context, message): void => {
    void executeWorkspaceList(context.socket, message, context.directories, context.signal);
};

export const handleSessionPrepare: CommandHandler<typeof SESSION_PREPARE_KIND> = (context, message): void => {
    void executeSessionPrepare(
        context.socket,
        message,
        context.resolveAgent,
        context.directories,
        context.sessions,
        context.diagnostics,
        context.signal,
    );
};

async function executeSessionCreate(context: CommandContext, command: SessionCreateCommand): Promise<void> {
    const timeout = new AbortController();
    const deadline = context.timer.schedule(
        () => timeout.abort(new DOMException("Session creation timed out", "TimeoutError")),
        120_000,
    );
    const signal = AbortSignal.any([context.signal, timeout.signal]);
    try {
        const input = {
            action: "create",
            harness: command.harness,
            directory: command.directory,
            configurations: command.configurations,
        };
        const create = async () => {
            const resolved = await resolveSessionDirectory(context.directories, command.directory, signal);
            const agent = await context.resolveAgent(command.harness, signal);
            return await context.sessionCreations.run(command.operationId, input, signal, async () => {
                const target = await context.sessions.createNativeSession({
                    ...agent,
                    cwd: resolved.cwd,
                    signal,
                });
                try {
                    const metrics = new AccumulatingOperationMetrics();
                    const created = await resolveMeasuredHeldSession(
                        target,
                        context.resolveAgent,
                        context.directories,
                        context.sessions,
                        metrics,
                        signal,
                    );
                    // A created Session reports the directory its creation named.
                    return await prepareSession(
                        command,
                        { ...created, directory: command.directory },
                        { kind: "interactive-only" },
                        context.sessions,
                        metrics,
                    );
                } catch (cause) {
                    if (!signal.aborted) {
                        // A refused creation leaves no Session behind in the Sessions this Computer holds.
                        await context.sessions.archiveSession(target, signal);
                    }
                    throw cause;
                }
            });
        };
        const ready = await (context.sessionCreations.recover(command.operationId, input, signal) ?? create());
        signal.throwIfAborted();
        context.diagnostics.daemonDiagnostic("session_creation_resolved", command.requestId, {
            harness: command.harness,
            operationId: command.operationId,
            sessionId: ready.target.sessionId,
        });
        send(context.socket, { ...ready, requestId: command.requestId });
    } catch (cause) {
        context.signal.throwIfAborted();
        const failure = timeout.signal.aborted
            ? new SessionError("session_creation_timeout", "Session creation timed out", { cause })
            : cause;
        context.diagnostics.daemonDiagnostic(
            "session_create_failed",
            command.requestId,
            { harness: command.harness, operationId: command.operationId, code: operationErrorCode(failure) },
            failure,
        );
        reportOperationFailure(context.socket, command.requestId, undefined, failure);
    } finally {
        deadline.cancel();
    }
}

export const handleSessionCreate: CommandHandler<typeof SESSION_CREATE_KIND> = (context, message): void => {
    void executeSessionCreate(context, message).catch((cause: unknown) => {
        if (!context.signal.aborted) {
            context.diagnostics.daemonDiagnostic(
                "session_create_failed",
                message.requestId,
                {
                    harness: message.harness,
                    operationId: message.operationId,
                    code: operationErrorCode(cause),
                },
                cause,
            );
        }
    });
};

export const handleSessionConfigure: CommandHandler<typeof SESSION_CONFIGURE_KIND> = (context, message): void => {
    void executeSessionConfigure(
        context.socket,
        message,
        context.resolveAgent,
        context.directories,
        context.sessions,
        context.signal,
    );
};

export const handleSessionRestore: CommandHandler<typeof SESSION_RESTORE_KIND> = (context, message): void => {
    void executeSessionRestore(
        context.socket,
        message,
        context.resolveAgent,
        context.directories,
        context.sessions,
        context.nativeSessions,
        context.diagnostics,
        context.signal,
    );
};

export const handleSessionRename: CommandHandler<typeof SESSION_RENAME_KIND> = (context, message): void => {
    void executeSessionRename(
        context.socket,
        message,
        context.resolveAgent,
        context.directories,
        context.sessions,
        context.nativeSessions,
        context.signal,
    );
};

async function executeSessionConfigRead(
    socket: WebSocket,
    command: SessionConfigReadCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    nativeSessions: NativeSessionService,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const metrics = new AccumulatingOperationMetrics();
    try {
        const entry = await metrics.measure("session-lookup", async () => {
            const [found] = await nativeSessions.querySessions([command.target], signal);
            if (found === undefined) {
                throw new SessionError("session_not_found", "The Session was not found");
            }
            return found;
        });
        const ready = await prepareSession(
            command,
            await resolveMeasuredHeldSession(entry.target, resolveAgent, directories, sessions, metrics, signal),
            // A settings read must not force history loading: Agents without
            // load support would fail even with a live process whose config is
            // already readable, and prepare reuses the current configuration.
            { kind: "interactive-only" },
            sessions,
            metrics,
        );
        send(socket, {
            configOptions: ready.configOptions,
            configurationRevision: ready.configurationRevision,
            kind: SESSION_CONFIG_READ_RESULT_KIND,
            requestId: command.requestId,
            target: command.target,
        });
    } catch (error) {
        diagnostics.daemonDiagnostic(
            "session_config_read_failed",
            command.requestId,
            {
                code: operationErrorCode(error),
                sessionId: command.target.sessionId,
            },
            error,
        );
        reportOperationFailure(socket, command.requestId, command.target, error, metrics.snapshot());
    }
}

export const handleSessionConfigRead: CommandHandler<typeof SESSION_CONFIG_READ_KIND> = (context, message): void => {
    void executeSessionConfigRead(
        context.socket,
        message,
        context.resolveAgent,
        context.directories,
        context.sessions,
        context.nativeSessions,
        context.diagnostics,
        context.signal,
    );
};
