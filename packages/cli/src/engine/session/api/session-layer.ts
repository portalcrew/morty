import type { SessionExecution } from "@morty-build/client/protocol";
import { AcpSessionTable } from "../../storage/session/acp-session-table.ts";
import { CommandLedgerTable } from "../../storage/session/command-ledger-table.ts";
import { LiveEventPositionTable } from "../../storage/session/live-event-position-table.ts";
import { SessionCreationTable } from "../../storage/session/session-creation-table.ts";
import { SessionEventCacheTable } from "../../storage/session/session-event-cache-table.ts";
import {
    computerSessionDatabasePaths,
    openAcpSessionDatabase,
    openSessionEventCacheDatabase,
} from "../../storage/sqlite/local-databases.ts";
import type { Timer } from "../../util/timer.ts";
import { SqliteSessionLiveEventPosition } from "../history/live-event-positions.ts";
import { CachedSessionEventStore } from "../history/session-event-store.ts";
import { SessionManager } from "../manager/session-manager.ts";
import { NativeSessionService } from "../native/native-session-browser.ts";
import type { AgentProcessPool } from "../process/agent-process-pool.ts";
import { PromptLifecycle } from "../prompt/prompt-lifecycle.ts";
import { SessionCreations } from "../record/session-creations.ts";
import { SqliteSessionStore } from "../record/session-store.ts";
import { ExecutionReceipts } from "../turn/execution-receipts.ts";
import { SessionTurns } from "../turn/session-turns.ts";
import { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";
import type { ResolveAgent, SessionEventSink } from "./session-api.ts";

/** What the session layer needs to wire itself: the runtime's identity, its agent source, and its sink. */
export interface SessionLayerOptions {
    readonly processes: AgentProcessPool;
    readonly computerId: string;
    readonly defaultWorkspace: string;
    readonly resolveAgent: ResolveAgent;
    readonly sink: SessionEventSink;
    readonly stateDirectory: string;
    readonly timer: Timer;
}

/** Wires the session layer for one runtime: its stores, manager, turns, and native session browsing. */
export function buildSessionLayer(options: SessionLayerOptions) {
    const { computerId, defaultWorkspace, resolveAgent, sink, stateDirectory, timer } = options;
    const databases = computerSessionDatabasePaths(stateDirectory, computerId);
    const sessionDatabase = openAcpSessionDatabase(databases.sessions);
    let events: CachedSessionEventStore;
    let operations: ExecutionReceipts;
    try {
        operations = new ExecutionReceipts(new CommandLedgerTable(sessionDatabase));
        events = new CachedSessionEventStore(
            new SessionEventCacheTable(openSessionEventCacheDatabase(databases.events)),
            new SqliteSessionLiveEventPosition(new LiveEventPositionTable(sessionDatabase)),
        );
    } catch (error) {
        sessionDatabase.close();
        throw error;
    }
    const sessionStore = new SqliteSessionStore(new AcpSessionTable(sessionDatabase), events);
    const activeSessions = new SessionTurns(operations, (target, commandId) => manager.executes(target, commandId));
    const sessionCreations = new SessionCreations(new SessionCreationTable(sessionDatabase));
    const directories = new WorkspaceDirectoryService(defaultWorkspace);
    const manager = new SessionManager({
        observer: {
            onBackgroundActivity: options.processes.notifyChanged,
            onSessionEvent: (event) => {
                operations.record(event);
                eventProjection.record(event);
            },
        },
        store: sessionStore,
        processes: options.processes,
        onSessionClosed: sink.publishClosed,
        lastTurn: operations.lastTurn,
        settledTurns: operations.settledTurns,
        timer,
    });
    const eventProjection = new PromptLifecycle(
        sink,
        async (sessionTarget, event) => {
            if (manager.recordLifecycleEvent(sessionTarget, event)) {
                return;
            }
            const recorded = events.append(sessionTarget, event);
            operations.record(recorded);
            eventProjection.record(recorded);
        },
        (sessionTarget, event, recordedAt) => events.append(sessionTarget, event, recordedAt),
        operations,
    );
    // The Session's commands, receipts, interactions and event position are read in one synchronous step.
    const nativeSessions = new NativeSessionService(
        resolveAgent,
        directories,
        manager,
        sessionCreations,
        (request): SessionExecution => {
            const interactionState = manager.interactionSnapshot(request.target);
            const { turn, queued } = activeSessions.executionSnapshot(request.target);
            const read = {
                queued,
                executionPosition: events.livePosition(request.target),
                interactionState,
                ...(request.deliveryCommandId === undefined
                    ? {}
                    : { command: operations.delivery(request.deliveryCommandId, request.target) }),
            };
            // How the last started command ended is told only while none runs.
            if (turn !== null) {
                return { ...read, turn };
            }
            const lastTurn = operations.lastTurn(request.target);
            return { ...read, turn: null, ...(lastTurn === undefined ? {} : { lastTurn }) };
        },
    );
    // Outcomes retained across a restart are published once. The sink keeps them until the Relay connects,
    // and a later reconnect does not replay events it already sent. An outcome the previous process recorded is
    // restated as the outcome it recorded, so status notifications do not take it for a new one.
    for (const recovered of operations.recover()) {
        switch (recovered.kind) {
            case "recorded":
                sink.publish(events.append(recovered.target, recovered.event, recovered.recordedAt));
                break;
            case "restated":
                eventProjection.restateOutcome(recovered.target, recovered.outcome);
                break;
        }
    }
    return {
        sessionCreations,
        activeSessions,
        directories,
        eventProjection,
        manager,
        nativeSessions,
        operations,
        sessionStore,
    };
}
