import type { NativeSessionTarget, SessionReadyEvent } from "@portalcrew/morty-client/protocol";
import type { PreparedSession, ResolveAgent, SessionPrepareOptions, SessionRecovery } from "../api/session-api.ts";
import type { SessionManager } from "../manager/session-manager.ts";
import { resolveSessionDirectory } from "../workspace/resolve-session-directory.ts";
import type { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";

export interface HeldSession {
    readonly options: SessionPrepareOptions;
    readonly directory: string;
    readonly directoryLabel: string;
}

/**
 * Resolves a command that names only a Session's target into the Session this Runtime holds: the Agent its target
 * names, and the directory it records, authorized again before use. A target it holds no Session for is refused as
 * `session_not_found`.
 */
export async function resolveHeldSession(
    sessions: Pick<SessionManager, "heldSession">,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    target: NativeSessionTarget,
    signal: AbortSignal,
): Promise<HeldSession> {
    signal.throwIfAborted();
    const session = sessions.heldSession(target);
    const resolved = await resolveSessionDirectory(directories, session.cwd, signal);
    return {
        options: {
            ...(await resolveAgent(session.harness, signal)),
            cwd: resolved.cwd,
            signal,
            target: session.target,
        },
        directory: session.cwd,
        directoryLabel: resolved.directoryLabel,
    };
}

export function sessionReady(
    requestId: string,
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
        requestId,
        target,
    };
}

export async function prepareHeldSession(
    sessions: Pick<SessionManager, "prepareSession" | "restoreSession">,
    requestId: string,
    session: HeldSession,
    recovery: SessionRecovery,
): Promise<SessionReadyEvent> {
    const preparation = session.options;
    const prepared =
        recovery.kind === "history-required"
            ? await sessions.restoreSession(preparation)
            : await sessions.prepareSession(preparation);
    return sessionReady(requestId, preparation.target, prepared, session);
}
