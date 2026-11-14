import type { NativeSessionTarget, SessionCreateCommand, SessionReadyEvent } from "@morty-build/client/protocol";
import {
    type SESSION_CONFIG_READ_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
    type SESSION_CONFIGURE_KIND,
    type SESSION_CREATE_KIND,
    type SESSION_PREPARE_KIND,
    type SESSION_RENAME_KIND,
    type SESSION_RESTORE_KIND,
    sessionConfigReadResultCodec,
    sessionConfigUpdatedEventCodec,
    sessionConfigurationSelection,
    sessionReadyEventCodec,
    sessionRenamedEventCodec,
    sessionRestoredEventCodec,
    type WORKSPACE_LIST_KIND,
    workspaceEntriesEventCodec,
} from "@morty-build/client/protocol";
import { operationErrorCode } from "../../../infra/operation-error.ts";
import type { PreparedSession, SessionRecovery } from "../../../session/api/session-api.ts";
import { SessionError } from "../../../session/api/session-error.ts";
import type { SessionManager } from "../../../session/manager/session-manager.ts";
import { applyCompleteSessionConfiguration } from "../../../session/prompt/apply-session-configuration.ts";
import { type HeldSession, resolveHeldSession } from "../../../session/record/held-session.ts";
import { resolveSessionDirectory } from "../../../session/workspace/resolve-session-directory.ts";
import type { CommandContext } from "../context.ts";
import type { CommandHandler } from "../definition.ts";
import { reportOperationFailure, send } from "../transport.ts";

/** What a preparation of a Session asks for, apart from the Session itself. */
interface SessionPreparationRequest {
    readonly requestId: string;
}

/** What a client is told of a Session whose Agent is prepared. */
function readyEvent(
    command: SessionPreparationRequest,
    target: NativeSessionTarget,
    prepared: PreparedSession,
    location: { readonly directory: string; readonly directoryLabel: string },
): SessionReadyEvent {
    return {
        agentName: prepared.agentName,
        agentVersion: prepared.agentVersion,
        capabilities: prepared.capabilities,
        commands: prepared.commands,
        configOptions: prepared.configOptions,
        configurationRevision: prepared.configurationRevision,
        directory: location.directory,
        directoryLabel: location.directoryLabel,
        kind: "session.ready",
        requestId: command.requestId,
        restored: prepared.restored,
        target,
    };
}

async function prepareSession(
    command: SessionPreparationRequest,
    session: HeldSession,
    recovery: SessionRecovery,
    sessions: SessionManager,
): Promise<SessionReadyEvent> {
    const preparation = session.options;
    const prepared =
        recovery.kind === "history-required"
            ? await sessions.restoreSession(preparation)
            : await sessions.prepareSession(preparation);
    return readyEvent(command, preparation.target, prepared, session);
}

export const handleWorkspaceList: CommandHandler<typeof WORKSPACE_LIST_KIND> = async (
    context,
    command,
): Promise<void> => {
    const { socket, payloadEncryption, directories, signal } = context;
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
};

export const handleSessionPrepare: CommandHandler<typeof SESSION_PREPARE_KIND> = async (
    context,
    command,
): Promise<void> => {
    const { socket, payloadEncryption, resolveAgent, directories, sessions, diagnostics, signal } = context;
    try {
        const readyEvent = await prepareSession(
            command,
            await resolveHeldSession(sessions, resolveAgent, directories, command.target, signal),
            { kind: "interactive-only" },
            sessions,
        );
        send(socket, await sessionReadyEventCodec.encode(readyEvent, payloadEncryption, signal));
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
        await reportOperationFailure(context, command.requestId, command.target, error);
    }
};

export const handleSessionRestore: CommandHandler<typeof SESSION_RESTORE_KIND> = async (
    context,
    command,
): Promise<void> => {
    const { socket, payloadEncryption, resolveAgent, directories, sessions, nativeSessions, diagnostics, signal } =
        context;
    try {
        const stored = sessions.findSessions([command.target])[0];
        const [entry] = await nativeSessions.querySessions(stored === undefined ? [] : [stored.target], signal);
        if (entry === undefined) {
            throw new SessionError("session_not_found", "The Session was not found");
        }
        const ready = await prepareSession(
            command,
            await resolveHeldSession(sessions, resolveAgent, directories, entry.target, signal),
            { kind: "history-required" },
            sessions,
        );
        // The restored Session is named once, by the reply's target.
        const { target: _entryTarget, ...record } = entry;
        const { kind: _kind, requestId: _requestId, target: _readyTarget, ...body } = ready;
        send(
            socket,
            await sessionRestoredEventCodec.encode(
                {
                    entry: record,
                    target: command.target,
                    kind: "session.restored",
                    ready: body,
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
        await reportOperationFailure(context, command.requestId, undefined, error);
    }
};

export const handleSessionRename: CommandHandler<typeof SESSION_RENAME_KIND> = async (
    context,
    command,
): Promise<void> => {
    const { socket, payloadEncryption, resolveAgent, directories, sessions, nativeSessions, signal } = context;
    try {
        const [entry] = await nativeSessions.querySessions([command.target], signal);
        if (entry === undefined) {
            throw new SessionError("session_not_found", "The Session was not found");
        }
        const resolved = await resolveSessionDirectory(directories, entry.directory, signal);
        const renamed = await sessions.renameSession(
            {
                ...(await resolveAgent(entry.target.harness, signal)),
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
};

export const handleSessionConfigure: CommandHandler<typeof SESSION_CONFIGURE_KIND> = async (
    context,
    command,
): Promise<void> => {
    const { socket, payloadEncryption, resolveAgent, directories, sessions, signal } = context;
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
                // A Session being created starts with exactly the settings it states, by the rule a Turn's settings use.
                const created = await context.sessions.createSession(
                    { ...agent, cwd: resolved.cwd, signal },
                    async ({ target, prepared }, creationSignal) =>
                        await applyCompleteSessionConfiguration(
                            context.sessions,
                            prepared.configOptions,
                            command.configurations,
                            "refuse",
                            agent.agent,
                            agent.adapter,
                            resolved.cwd,
                            command.requestId,
                            target,
                            creationSignal,
                        ),
                );
                // A created Session reports the directory its creation named.
                return readyEvent(command, created.target, created.prepared, {
                    directory: command.directory,
                    directoryLabel: resolved.directoryLabel,
                });
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

export const handleSessionConfigRead: CommandHandler<typeof SESSION_CONFIG_READ_KIND> = async (
    context,
    command,
): Promise<void> => {
    const { socket, payloadEncryption, resolveAgent, directories, sessions, nativeSessions, diagnostics, signal } =
        context;
    try {
        const [entry] = await nativeSessions.querySessions([command.target], signal);
        if (entry === undefined) {
            throw new SessionError("session_not_found", "The Session was not found");
        }
        const ready = await prepareSession(
            command,
            await resolveHeldSession(sessions, resolveAgent, directories, entry.target, signal),
            // A settings read must not force history loading: Agents without
            // load support would fail even with a live process whose config is
            // already readable, and prepare reuses the current configuration.
            { kind: "interactive-only" },
            sessions,
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
        await reportOperationFailure(context, command.requestId, command.target, error);
    }
};
