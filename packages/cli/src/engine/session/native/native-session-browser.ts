import { randomUUID } from "node:crypto";
import {
    decodeIdentifier,
    type Identifier,
    type NativeSessionCommand,
    type NativeSessionEntry,
    type NativeSessionResult,
    type NativeSessionTarget,
    type SessionExecution,
    type SessionMetadata,
    type SessionReadyBody,
    type SessionReadyEvent,
} from "@morty-build/client/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { NativeSessionInfo } from "../../acp/protocol/native-session.ts";
import { sessionIdSchema } from "../../acp/protocol/native-session.ts";
import type { ResolveAgent, SessionCreationOptions } from "../api/session-api.ts";
import { RuntimeOperations } from "../manager/operation-drain.ts";
import type { SessionManager } from "../manager/session-manager.ts";
import type { SessionCreations } from "../record/session-creations.ts";
import type { StoredSession } from "../record/session-store.ts";
import { LocalAuthorizationError } from "../workspace/local-authorization-error.ts";
import type { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";
import { nativeSessionQuery } from "./native-query.ts";

interface ListedCursor {
    readonly scope: string;
    readonly cursor: string;
}
interface AuthorizedNativeSession {
    readonly info: NativeSessionInfo;
    readonly cwd: string;
    readonly directory: string;
    readonly directoryLabel: string;
}

const MAXIMUM_SESSION_TITLE_LENGTH = 500;
const forkSuffixPattern = / \(Fork #([1-9][0-9]*)\)$/u;

function nextForkTitle(sourceTitle: string, sessions: readonly StoredSession[]): string {
    let highest = 0;
    for (const session of sessions) {
        const match = forkSuffixPattern.exec(session.title);
        const encodedNumber = match?.[1];
        if (encodedNumber === undefined) {
            continue;
        }
        const number = Number(encodedNumber);
        if (!Number.isSafeInteger(number)) {
            continue;
        }
        const suffix = ` (Fork #${number})`;
        if (`${sourceTitle.slice(0, MAXIMUM_SESSION_TITLE_LENGTH - suffix.length)}${suffix}` === session.title) {
            highest = Math.max(highest, number);
        }
    }
    const number = highest + 1;
    const suffix = ` (Fork #${number})`;
    return `${sourceTitle.slice(0, MAXIMUM_SESSION_TITLE_LENGTH - suffix.length)}${suffix}`;
}

/** A Session's preparation without the identity the reply carrying it already states. */
function readyBody(ready: SessionReadyEvent): SessionReadyBody {
    const { kind: _kind, requestId: _requestId, target: _target, ...body } = ready;
    return body;
}

/** Only client intent identifies a Fork; native metadata is mutable execution input. */
function forkIntent(command: Extract<NativeSessionCommand, { readonly action: "fork" | "import" }>) {
    return { action: "fork", harness: command.harness, sessionId: command.sessionId, directory: command.directory };
}

export class NativeSessionService {
    readonly #operations = new RuntimeOperations();
    readonly #cursors = new Map<string, ListedCursor>();
    readonly #resolveAgent: ResolveAgent;
    readonly #directories: WorkspaceDirectoryService;
    readonly #sessions: SessionManager;
    readonly #creations: SessionCreations;
    readonly #activeTurn: (
        command: Extract<NativeSessionCommand, { readonly action: "active-turn" }>,
    ) => SessionExecution;

    constructor(
        resolveAgent: ResolveAgent,
        directories: WorkspaceDirectoryService,
        sessions: SessionManager,
        creations: SessionCreations,
        activeTurn: (command: Extract<NativeSessionCommand, { readonly action: "active-turn" }>) => SessionExecution,
    ) {
        this.#resolveAgent = resolveAgent;
        this.#directories = directories;
        this.#sessions = sessions;
        this.#creations = creations;
        this.#activeTurn = activeTurn;
    }

    readonly execute = async (command: NativeSessionCommand, signal: AbortSignal): Promise<NativeSessionResult> => {
        return await this.#operations.run({ signal }, (scoped) => this.#execute(command, scoped.signal));
    };

    readonly close = (): Promise<void> => this.#operations.close(async () => undefined);

    readonly readSessionHistory = async (
        options: SessionCreationOptions,
        sessionId: string,
        eventLimit: number,
        cursor: string | null,
    ) =>
        this.#operations.run(options, (scoped) =>
            this.#sessions.withNativeSessionOperation(scoped, sessionId, (target) =>
                target.adapter.readSessionHistory({
                    query: nativeSessionQuery(target),
                    request: {
                        sessionId,
                        eventLimit,
                        cursor,
                    },
                }),
            ),
        );

    readonly #execute = async (command: NativeSessionCommand, signal: AbortSignal): Promise<NativeSessionResult> => {
        if (command.action !== "fork") {
            return await this.#executeNew(command, signal);
        }
        // The receipt answers the original intent before consulting the Agent or its mutable native directory.
        const recovered = this.#creations.recover(command.requestId, forkIntent(command), signal);
        if (recovered === null) {
            return await this.#executeNew(command, signal);
        }
        const ready = await recovered;
        return {
            kind: "native.session.result",
            requestId: command.requestId,
            action: "fork",
            ready: readyBody(ready),
            target: ready.target,
            title: this.#sessions.findSessions([ready.target])[0]?.title ?? "Untitled session",
        };
    };

    readonly #executeNew = async (command: NativeSessionCommand, signal: AbortSignal): Promise<NativeSessionResult> => {
        signal.throwIfAborted();
        if (command.action === "active-turn") {
            return {
                action: "active-turn",
                kind: "native.session.result",
                requestId: command.requestId,
                target: command.target,
                ...this.#activeTurn(command),
            };
        }
        const cwd = await this.#directories.resolve(command.directory, signal);
        signal.throwIfAborted();
        const options: SessionCreationOptions = {
            ...(await this.#resolveAgent(command.harness, signal)),
            cwd,
            signal,
        };
        const capabilities = await options.adapter.getCapabilities(nativeSessionQuery(options));
        if (!capabilities.listSessions) {
            throw new AcpExecutionError(
                "This Agent does not support native session listing",
                {},
                "native_session_unsupported",
            );
        }
        const cursorScope = JSON.stringify([command.harness, cwd]);
        const register = async (info: NativeSessionInfo): Promise<NativeSessionEntry | null> => {
            const authorized = await this.authorizeEntry(options, info);
            if (authorized === null) {
                return null;
            }
            return {
                sessionId: decodeIdentifier(info.sessionId),
                title: info.title ?? "Untitled session",
                directory: authorized.directory,
                directoryLabel: authorized.directoryLabel,
                updatedAt: info.updatedAt ?? null,
            };
        };
        const envelope = {
            kind: "native.session.result",
            requestId: command.requestId,
        } satisfies Pick<NativeSessionResult, "kind" | "requestId">;
        if (command.action === "list") {
            let cursor: string | null = null;
            if (command.cursor !== null) {
                const known = this.#cursors.get(command.cursor);
                if (known?.scope !== cursorScope) {
                    throw new AcpExecutionError(
                        "Refresh the native session list before continuing",
                        {},
                        "native_session_cursor_expired",
                    );
                }
                cursor = known.cursor;
            }
            const page = await options.adapter.listSessions({ query: nativeSessionQuery(options), cursor });
            const entries: NativeSessionEntry[] = [];
            for (const info of page.sessions) {
                const entry = await register(info);
                if (entry !== null) {
                    entries.push(entry);
                }
            }
            let nextCursor: Identifier | null = null;
            if (page.nextCursor != null) {
                if (page.nextCursor === cursor) {
                    throw new AcpExecutionError(
                        "The Agent returned a repeated session cursor",
                        {},
                        "invalid_native_session_response",
                    );
                }
                nextCursor = decodeIdentifier(randomUUID());
                if (this.#cursors.size >= 500) {
                    this.#cursors.clear();
                }
                this.#cursors.set(nextCursor, {
                    scope: cursorScope,
                    cursor: page.nextCursor,
                });
            }
            return {
                ...envelope,
                action: "list",
                capabilities,
                entries,
                nextCursor,
            };
        }
        if (command.action === "find") {
            const found = await options.adapter.findSession({
                query: nativeSessionQuery(options),
                sessionId: command.sessionId,
                budget: {
                    maximumPages: 500,
                    maximumEntries: 500,
                },
            });
            const entry = await register(found);
            if (entry !== null) {
                return { ...envelope, action: "find", entry };
            }
            throw new AcpExecutionError("The native session was not found", {}, "native_session_not_found");
        }
        const target = await this.resolveTarget(options, command.sessionId);
        const action = command.action;
        if (action === "import" && !capabilities.loadSession && !capabilities.resumeSession) {
            throw new AcpExecutionError("This Agent cannot import native sessions", {}, "native_session_unsupported");
        }
        if (action === "fork" && !capabilities.unstableForkSession) {
            throw new AcpExecutionError(
                "This Agent does not support session forking",
                {},
                "native_session_unsupported",
            );
        }
        const sourceTitle = target.info.title ?? "Untitled session";
        const title =
            action === "fork"
                ? nextForkTitle(sourceTitle, this.#sessions.listSessions(Number.MAX_SAFE_INTEGER))
                : sourceTitle;
        const open = async (): Promise<SessionReadyEvent> => {
            const opened = await this.#sessions.openNativeSession(
                {
                    ...options,
                    cwd: target.cwd,
                },
                action === "fork"
                    ? { kind: "fork", sessionId: target.info.sessionId, title }
                    : { kind: "import", sessionId: target.info.sessionId, title },
                this.#resolveAgent,
            );
            signal.throwIfAborted();
            return {
                agentName: opened.prepared.agentName,
                agentVersion: opened.prepared.agentVersion,
                capabilities: opened.prepared.capabilities,
                commands: opened.prepared.commands,
                configOptions: opened.prepared.configOptions,
                configurationRevision: opened.prepared.configurationRevision,
                directory: target.directory,
                directoryLabel: target.directoryLabel,
                kind: "session.ready",
                requestId: command.requestId,
                restored: true,
                target: opened.target,
            };
        };
        const ready =
            action === "fork"
                ? await this.#creations.run(command.requestId, forkIntent(command), signal, open)
                : await open();
        return {
            ...envelope,
            action,
            ready: readyBody(ready),
            target: ready.target,
            title: this.#sessions.findSessions([ready.target])[0]?.title ?? title,
        };
    };

    readonly listSessions = async (limit: number, signal: AbortSignal): Promise<readonly SessionMetadata[]> => {
        signal.throwIfAborted();
        return this.describeSessions(this.#sessions.listSessions(limit));
    };

    readonly querySessions = async (
        targets: readonly NativeSessionTarget[],
        signal: AbortSignal,
    ): Promise<readonly SessionMetadata[]> => {
        signal.throwIfAborted();
        return this.describeSessions(this.#sessions.findSessions(targets));
    };

    private readonly describeSessions = (sessions: readonly StoredSession[]): readonly SessionMetadata[] => {
        const entries: SessionMetadata[] = [];
        for (const session of sessions) {
            // Report the recorded workspace even if it was deleted or unmounted.
            const directory = this.#directories.identifyRecorded(session.cwd);
            entries.push({
                directory: directory.directory,
                directoryLabel: directory.label,
                prompted: session.prompted,
                target: session.target,
                status: this.#sessions.sessionStatus(session.target),
                title: session.title || "Untitled session",
                updatedAt: session.updatedAt,
            });
        }
        return entries;
    };

    private readonly authorizeEntry = async (
        options: SessionCreationOptions,
        info: NativeSessionInfo,
    ): Promise<AuthorizedNativeSession | null> => {
        try {
            const primary = await this.#directories.identify(info.cwd, options.signal);
            return {
                info,
                cwd: primary.path,
                directory: primary.directory,
                directoryLabel: primary.label,
            };
        } catch (error) {
            options.signal.throwIfAborted();
            if (error instanceof LocalAuthorizationError) {
                return null;
            }
            throw error;
        }
    };

    private readonly resolveTarget = async (
        options: SessionCreationOptions,
        sessionId: string,
    ): Promise<AuthorizedNativeSession> => {
        sessionIdSchema.parse(sessionId);
        const info = await options.adapter
            .findSession({
                query: nativeSessionQuery(options),
                sessionId,
                budget: {
                    maximumPages: 100,
                    maximumEntries: null,
                },
            })
            .catch((cause: unknown) => {
                options.signal.throwIfAborted();
                if (cause instanceof AcpExecutionError && cause.code === "native_session_not_found") {
                    throw new AcpExecutionError(
                        "The selected native session no longer exists. Refresh the list.",
                        { cause },
                        "native_session_not_found",
                    );
                }
                throw cause;
            });
        if (info.sessionId !== sessionId) {
            throw new AcpExecutionError(
                "The Agent returned a different Session",
                {},
                "invalid_native_session_response",
            );
        }
        const target = await this.authorizeEntry(options, info);
        if (target === null) {
            throw new LocalAuthorizationError("The selected native session is not authorized");
        }
        if (target.cwd !== options.cwd) {
            throw new AcpExecutionError(
                "This session's directory changed. Refresh the list before continuing.",
                {},
                "native_session_target_changed",
            );
        }
        return target;
    };
}
