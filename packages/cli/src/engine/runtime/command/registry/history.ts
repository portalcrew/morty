import {
    type decodeSessionHistoryPageLoad,
    type decodeSessionPreviewHistoryPageLoad,
    ENCRYPTED_MESSAGE_MAX_PLAINTEXT_BYTES,
    ENCRYPTED_MESSAGE_MAX_WIRE_BYTES,
    type NativeSessionEvents,
    type SESSION_HISTORY_PAGE_LOAD_KIND,
    SESSION_HISTORY_PAGE_LOADED_KIND,
    type SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND,
    SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
    type SessionEvent,
    sessionHistoryPageLoadedCodec,
    sessionPreviewHistoryPageLoadedCodec,
} from "@morty-build/client/protocol";
import { operationErrorCode } from "../../../infra/operation-error.ts";
import type { ResolveAgent } from "../../../session/api/session-api.ts";
import { SessionError } from "../../../session/api/session-error.ts";
import type { SessionEventPage } from "../../../session/history/session-event-store.ts";
import type { SessionManager } from "../../../session/manager/session-manager.ts";
import type { NativeSessionService } from "../../../session/native/native-session-browser.ts";
import { resolveSessionDirectory } from "../../../session/workspace/resolve-session-directory.ts";
import type { WorkspaceDirectoryService } from "../../../session/workspace/workspace-directory.ts";
import type { RelayConnectionDiagnostics } from "../../relay/diagnostics.ts";
import type { CommandContext } from "../context.ts";
import type { CommandHandler } from "../definition.ts";
import { reportOperationFailure, send } from "../transport.ts";

interface OrderedHistoryEvent {
    readonly cursor: string | null;
    readonly event: SessionEvent;
}

const HISTORY_ROUTING_RESERVE = 4096;
const fitsHistoryFrame = (privateBytes: number): boolean =>
    privateBytes + HISTORY_ROUTING_RESERVE <= ENCRYPTED_MESSAGE_MAX_PLAINTEXT_BYTES &&
    Math.ceil(((privateBytes + HISTORY_ROUTING_RESERVE + 37) * 4) / 3) + HISTORY_ROUTING_RESERVE <=
        ENCRYPTED_MESSAGE_MAX_WIRE_BYTES;

async function loadHistoryPage(
    eventLimit: number,
    initialCursor: string | null,
    load: (eventLimit: number, cursor: string | null) => Promise<SessionEventPage>,
): Promise<NativeSessionEvents> {
    let cursor = initialCursor;
    let loaded: readonly OrderedHistoryEvent[] = [];
    let sessionGenerationId: string | null = null;
    let sourceNextCursor: string | null = null;
    let throughPosition: string | null = null;
    do {
        const replay = await load(eventLimit, cursor);
        // Keep the newest page's cut: older pages must not advance the live boundary.
        throughPosition ??= replay.throughPosition;
        if (sessionGenerationId !== null && replay.sessionGenerationId !== sessionGenerationId) {
            throw new SessionError("session_reloaded", "The Session reloaded while history was loading");
        }
        sessionGenerationId = replay.sessionGenerationId;
        const events = replay.events.map((event, index) => {
            const eventCursor = replay.nextCursor === null && index === 0 ? null : event.eventId;
            return { cursor: eventCursor, event };
        });
        loaded = [...events, ...loaded];
        sourceNextCursor = replay.nextCursor;
        if (loaded.length >= eventLimit) {
            break;
        }
        cursor = sourceNextCursor;
    } while (cursor !== null);

    if (sessionGenerationId === null || throughPosition === null) {
        throw new SessionError("session_history_unavailable", "The Session history is unavailable");
    }
    const candidates = loaded.slice(-eventLimit);
    // The encrypted private JSON contains the page and queue. Reserve space for the
    // routing JSON, a 512-character cursor, the AES-GCM packet and base64 framing.
    const empty = {
        events: {
            events: [],
            nextCursor: null,
            sessionGenerationId,
            throughPosition,
        },
    };
    let privateBytes = Buffer.byteLength(JSON.stringify({ events: empty }));
    if (!fitsHistoryFrame(privateBytes)) {
        throw new SessionError(
            "session_history_unavailable",
            "The Session history metadata exceeds the supported response size",
        );
    }
    let first = candidates.length;
    while (first > 0) {
        const candidate = candidates[first - 1];
        if (candidate === undefined) {
            break;
        }
        const bytes = Buffer.byteLength(JSON.stringify(candidate.event)) + (first === candidates.length ? 0 : 1);
        if (!fitsHistoryFrame(privateBytes + bytes)) {
            break;
        }
        privateBytes += bytes;
        first -= 1;
    }
    if (first === candidates.length && candidates.length > 0) {
        throw new SessionError(
            "session_history_unavailable",
            "A Session history event exceeds the supported response size",
        );
    }
    const orderedEvents = candidates.slice(first);
    const nextCursor = orderedEvents[0]?.cursor ?? null;
    return {
        events: {
            events: orderedEvents.map(({ event }) => event),
            nextCursor,
            sessionGenerationId,
            throughPosition,
        },
    };
}

async function executeSessionHistoryPageLoad(
    context: CommandContext,
    command: ReturnType<typeof decodeSessionHistoryPageLoad>,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    diagnostics: RelayConnectionDiagnostics,
    sessions: SessionManager,
    nativeSessions: NativeSessionService,
    signal: AbortSignal,
): Promise<void> {
    const { socket, payloadEncryption } = context;
    let harness: string | undefined;
    try {
        const [entry] = await nativeSessions.querySessions([command.target], signal);
        if (entry === undefined) {
            throw new SessionError("session_not_found", "The Session was not found");
        }
        harness = entry.target.harness;
        const resolved = await resolveSessionDirectory(directories, entry.directory, signal);
        const loadOptions = {
            ...(await resolveAgent(entry.target.harness, signal)),
            cwd: resolved.cwd,
            target: command.target,
            signal,
        };
        const events = await loadHistoryPage(
            command.eventLimit,
            command.cursor,
            async (eventLimit, cursor) => await sessions.loadSessionEvents(loadOptions, eventLimit, cursor),
        );
        signal.throwIfAborted();
        const encoded = await sessionHistoryPageLoadedCodec.encode(
            {
                events,
                kind: SESSION_HISTORY_PAGE_LOADED_KIND,
                requestId: command.requestId,
                target: command.target,
            },
            payloadEncryption,
            signal,
        );
        if (Buffer.byteLength(encoded) > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES) {
            throw new SessionError(
                "session_history_unavailable",
                "The Session history response exceeds the supported size",
            );
        }
        send(socket, encoded);
    } catch (error) {
        if (!signal.aborted) {
            diagnostics.daemonDiagnostic(
                "session_history_v2_load_failed",
                command.requestId,
                {
                    ...(harness === undefined ? {} : { harness }),
                    code: operationErrorCode(error),
                    sessionId: command.target.sessionId,
                },
                error,
            );
            await reportOperationFailure(context, command.requestId, command.target, error);
        }
    }
}

async function executeSessionPreviewHistoryPageLoad(
    context: CommandContext,
    command: ReturnType<typeof decodeSessionPreviewHistoryPageLoad>,
    resolveAgent: ResolveAgent,
    directories: WorkspaceDirectoryService,
    diagnostics: RelayConnectionDiagnostics,
    nativeSessions: NativeSessionService,
    signal: AbortSignal,
): Promise<void> {
    const { socket, payloadEncryption } = context;
    try {
        const resolved = await resolveSessionDirectory(directories, command.directory, signal);
        const loadOptions = {
            ...(await resolveAgent(command.target.harness, signal)),
            cwd: resolved.cwd,
            target: command.target,
            signal,
        };
        const events = await loadHistoryPage(
            command.eventLimit,
            command.cursor,
            async (eventLimit, cursor) =>
                await nativeSessions.readSessionHistory(loadOptions, command.target.sessionId, eventLimit, cursor),
        );
        signal.throwIfAborted();
        const encoded = await sessionPreviewHistoryPageLoadedCodec.encode(
            {
                events,
                kind: SESSION_PREVIEW_HISTORY_PAGE_LOADED_KIND,
                requestId: command.requestId,
                target: command.target,
            },
            payloadEncryption,
            signal,
        );
        if (Buffer.byteLength(encoded) > ENCRYPTED_MESSAGE_MAX_WIRE_BYTES) {
            throw new SessionError(
                "session_history_unavailable",
                "The Session history response exceeds the supported size",
            );
        }
        send(socket, encoded);
    } catch (error) {
        if (!signal.aborted) {
            diagnostics.daemonDiagnostic(
                "session_history_v2_load_failed",
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
    }
}

export const handleSessionHistoryPageLoad: CommandHandler<typeof SESSION_HISTORY_PAGE_LOAD_KIND> = (
    context,
    message,
): Promise<void> => {
    return executeSessionHistoryPageLoad(
        context,
        message,
        context.resolveAgent,
        context.directories,
        context.diagnostics,
        context.sessions,
        context.nativeSessions,
        context.signal,
    );
};

export const handlePreviewHistoryPageLoad: CommandHandler<typeof SESSION_PREVIEW_HISTORY_PAGE_LOAD_KIND> = (
    context,
    message,
): Promise<void> => {
    return executeSessionPreviewHistoryPageLoad(
        context,
        message,
        context.resolveAgent,
        context.directories,
        context.diagnostics,
        context.nativeSessions,
        context.signal,
    );
};
