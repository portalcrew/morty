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
    sessionConfigReadResultCodec,
    sessionConfigUpdatedEventCodec,
    sessionReadyEventCodec,
    sessionRenamedEventCodec,
    sessionRestoredEventCodec,
    type WORKSPACE_LIST_KIND,
    workspaceEntriesEventCodec,
} from "@morty-build/client/protocol";
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
    context: CommandContext,
    command: WorkspaceListCommand,
    directories: WorkspaceDirectoryService,
    signal: AbortSignal,
): Promise<void> {
    const { socket, payloadEncryption } = context;
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
        send(
            socket,
            await workspaceEntriesEventCodec.encode(
                {
                    directory: listing.directory,
                    directoryLabel: listing.directoryLabel,
                    entries: listing.entries,
                    kind: "workspace.entries",
                    parentDirectory: listing.parentDirectory,
                    requestId: command.requestId,
                },
                payloadEncryption,
                signal,
            ),
        );
    } catch (error) {
        await reportOperationFailure(context, command.requestId, undefined, error);
    }
}

async function executeSessionPrepare(
    context: CommandContext,
    command: SessionPrepareCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const { socket, payloadEncryption } = context;
    const metrics = new AccumulatingOperationMetrics();
    try {
        const readyEvent = await prepareSession(
            command,
            await resolveMeasuredHeldSession(command.target, resolveAgent, directories, sessions, metrics, signal),
            { kind: "interactive-only" },
            sessions,
            metrics,
        );
        send(
            socket,
            await sessionReadyEventCodec.encode(
                {
                    ...readyEvent,
                    runtimeTimings: metrics.snapshot(),
                },
                payloadEncryption,
                signal,
            ),
        );
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
        await reportOperationFailure(context, command.requestId, command.target, error, metrics.snapshot());
    }
}

async function executeSessionRestore(
    context: CommandContext,
    command: SessionRestoreCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    nativeSessions: NativeSessionService,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const { socket, payloadEncryption } = context;
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
        send(
            socket,
            await sessionRestoredEventCodec.encode(
                {
                    entry,
                    target: command.target,
                    kind: "session.restored",
                    ready: { ...ready, runtimeTimings: metrics.snapshot() },
                    requestId: command.requestId,
                },
                payloadEncryption,
                signal,
            ),
        );
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
        await reportOperationFailure(context, command.requestId, undefined, error, metrics.snapshot());
    }
}

async function executeSessionRename(
    context: CommandContext,
    command: SessionRenameCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    nativeSessions: NativeSessionService,
    signal: AbortSignal,
): Promise<void> {
    const { socket, payloadEncryption } = context;
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
        send(
            socket,
            await sessionRenamedEventCodec.encode(
                {
                    kind: "session.renamed",
                    requestId: command.requestId,
                    target: command.target,
                    title: renamed.title,
                    updatedAt: renamed.updatedAt,
                },
                payloadEncryption,
                signal,
            ),
        );
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        await reportOperationFailure(context, command.requestId, command.target, error);
    }
}

async function executeSessionConfigure(
    context: CommandContext,
    command: SessionConfigureCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    signal: AbortSignal,
): Promise<void> {
    const { socket, payloadEncryption } = context;
    try {
        const session = await resolveHeldSession(sessions, resolveAgent, directories, command.target, signal);
        const snapshot = await sessions.configureSession({
            ...session.options,
            ...sessionConfigurationSelection(command),
            expectedConfigurationRevision: command.expectedConfigurationRevision,
            requestId: command.requestId,
        });
        send(
            socket,
            await sessionConfigUpdatedEventCodec.encode(
                {
                    ...snapshot,
                    kind: "session.config.updated",
                    requestId: command.requestId,
                    target: command.target,
                },
                payloadEncryption,
                signal,
            ),
        );
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        await reportOperationFailure(context, command.requestId, command.target, error);
    }
}

export const handleWorkspaceList: CommandHandler<typeof WORKSPACE_LIST_KIND> = (context, message): Promise<void> => {
    return executeWorkspaceList(context, message, context.directories, context.signal);
};

export const handleSessionPrepare: CommandHandler<typeof SESSION_PREPARE_KIND> = (context, message): Promise<void> => {
    return executeSessionPrepare(
        context,
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
        send(
            context.socket,
            await sessionReadyEventCodec.encode(
                { ...ready, requestId: command.requestId },
                context.payloadEncryption,
                signal,
            ),
        );
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
        await reportOperationFailure(context, command.requestId, undefined, failure);
    } finally {
        deadline.cancel();
    }
}

export const handleSessionCreate: CommandHandler<typeof SESSION_CREATE_KIND> = (context, message): Promise<void> => {
    return executeSessionCreate(context, message).catch((cause: unknown) => {
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

export const handleSessionConfigure: CommandHandler<typeof SESSION_CONFIGURE_KIND> = (
    context,
    message,
): Promise<void> => {
    return executeSessionConfigure(
        context,
        message,
        context.resolveAgent,
        context.directories,
        context.sessions,
        context.signal,
    );
};

export const handleSessionRestore: CommandHandler<typeof SESSION_RESTORE_KIND> = (context, message): Promise<void> => {
    return executeSessionRestore(
        context,
        message,
        context.resolveAgent,
        context.directories,
        context.sessions,
        context.nativeSessions,
        context.diagnostics,
        context.signal,
    );
};

export const handleSessionRename: CommandHandler<typeof SESSION_RENAME_KIND> = (context, message): Promise<void> => {
    return executeSessionRename(
        context,
        message,
        context.resolveAgent,
        context.directories,
        context.sessions,
        context.nativeSessions,
        context.signal,
    );
};

async function executeSessionConfigRead(
    context: CommandContext,
    command: SessionConfigReadCommand,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    sessions: SessionManager,
    nativeSessions: NativeSessionService,
    diagnostics: RelayConnectionDiagnostics,
    signal: AbortSignal,
): Promise<void> {
    const { socket, payloadEncryption } = context;
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
        send(
            socket,
            await sessionConfigReadResultCodec.encode(
                {
                    configOptions: ready.configOptions,
                    configurationRevision: ready.configurationRevision,
                    kind: SESSION_CONFIG_READ_RESULT_KIND,
                    requestId: command.requestId,
                    target: command.target,
                },
                payloadEncryption,
                signal,
            ),
        );
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
        await reportOperationFailure(context, command.requestId, command.target, error, metrics.snapshot());
    }
}

export const handleSessionConfigRead: CommandHandler<typeof SESSION_CONFIG_READ_KIND> = (
    context,
    message,
): Promise<void> => {
    return executeSessionConfigRead(
        context,
        message,
        context.resolveAgent,
        context.directories,
        context.sessions,
        context.nativeSessions,
        context.diagnostics,
        context.signal,
    );
};
