import { NativeSessionSet } from "@portalcrew/morty-client/native-session";
import type { SessionExecution } from "@portalcrew/morty-client/protocol";
import { CommandLedgerTable } from "../../storage/session/command-ledger-table.ts";
import { LiveEventPositionTable } from "../../storage/session/live-event-position-table.ts";
import { SessionEventCacheTable } from "../../storage/session/session-event-cache-table.ts";
import {
    computerSessionDatabasePaths,
    openAcpSessionDatabase,
    openSessionEventCacheDatabase,
} from "../../storage/sqlite/local-databases.ts";
import type { Timer } from "../../util/timer.ts";
import { waitForSharedOperation } from "../../util/wait-for-shared-operation.ts";
import { SqliteSessionLiveEventPosition } from "../history/live-event-positions.ts";
import { CachedSessionEventStore } from "../history/session-event-store.ts";
import { SessionManager } from "../manager/session-manager.ts";
import { NativeSessionService } from "../native/native-session-browser.ts";
import type { AgentProcessPool } from "../process/agent-process-pool.ts";
import { PromptLifecycle } from "../prompt/prompt-lifecycle.ts";
import { SessionCreations } from "../record/session-creations.ts";
import { SqliteSessionStore } from "../record/session-store.ts";
import { CommandStandings } from "../turn/command-standings.ts";
import { ExecutionReceipts } from "../turn/execution-receipts.ts";
import { SessionTurns } from "../turn/session-turns.ts";
import { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";
import type { ResolveAgent, SessionEventSink } from "./session-api.ts";

export interface SessionLayerOptions {
    readonly processes: AgentProcessPool;
    readonly computerId: string;
    readonly defaultWorkspace: string;
    readonly resolveAgent: ResolveAgent;
    readonly sink: SessionEventSink;
    readonly stateDirectory: string;
    readonly timer: Timer;
}

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
    const sessionStore = new SqliteSessionStore(sessionDatabase, events);
    const activeSessions = new SessionTurns(
        operations,
        {
            executes: (target, commandId) => manager.executes(target, commandId),
            stopping: (target, commandId) => manager.stopping(target, commandId),
        },
        (target) => manager.turnFinished(target),
    );
    const standings = new CommandStandings(activeSessions, events.livePosition);
    const sessionCreations = new SessionCreations(sessionStore);
    const directories = new WorkspaceDirectoryService(defaultWorkspace);
    const manager = new SessionManager({
        observer: {
            onObservedTurn: async (target, observation) => {
                // A local prompt can still be unwinding when Codex announces the next turn.
                // Never replace its execution entry or send its pending stop to the successor.
                const previous = activeSessions.session(target).working();
                if (previous && manager.executes(target, previous.command.commandId)) {
                    const stillActive = await Promise.race([
                        previous.completion.then(() => true),
                        observation.completion.then(
                            () => false,
                            () => false,
                        ),
                    ]);
                    if (!stillActive) {
                        return;
                    }
                }
                const { commandId } = observation;
                const command = {
                    kind: "session.prompt",
                    disposition: "append",
                    commandId,
                    requestId: commandId,
                    target,
                    prompt: "",
                    attachments: [],
                } as const;
                const receipt = operations.claimExecution(commandId, target, JSON.stringify(command), () => true);
                if (receipt.kind !== "accepted") {
                    return;
                }
                const finishExecution = manager.observeExecution(target, commandId);
                const turn = activeSessions.start(command, () => {});
                turn.admit({ kind: "own" });
                const started = events.append(target, {
                    type: "lifecycle-metadata",
                    payload: { kind: "prompt.started", commandId, attemptId: receipt.attemptId },
                });
                operations.record(started);
                eventProjection.record(started);
                // This receipt exposes native work through the existing turn controls. Its empty prompt is never submitted.
                return waitForSharedOperation(observation.completion, turn.signal)
                    .then(
                        (reason) =>
                            eventProjection.completed(
                                target,
                                commandId,
                                reason === "cancelled" ? { kind: "cancelled" } : { kind: "ended", stopReason: reason },
                            ),
                        () =>
                            eventProjection.failed(
                                target,
                                commandId,
                                receipt.attemptId,
                                "codex_shared_turn_unavailable",
                                "The shared Codex turn ended with an error or its connection closed.",
                            ),
                    )
                    .finally(() => {
                        finishExecution();
                        activeSessions.finish(turn);
                        eventProjection.publishTerminal(target, commandId);
                    })
                    .catch((error: unknown) => console.error("Could not settle a shared Codex turn", error));
            },
            onBackgroundActivity: options.processes.notifyChanged,
            onSessionEvent: (event) => {
                operations.record(event);
                eventProjection.record(event);
            },
            onPromptSuggestions: sink.publishPromptSuggestions,
        },
        store: sessionStore,
        processes: options.processes,
        onSessionClosed: sink.publishClosed,
        received: operations.received,
        settledTurns: operations.settledTurns,
        hasUnsettledTurn: activeSessions.hasUnsettledTurn,
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
    const nativeSessions = new NativeSessionService(
        resolveAgent,
        directories,
        manager,
        sessionCreations,
        activeSessions.status,
        (request): SessionExecution => ({
            ...activeSessions.execution(request.target),
            executionPosition: standings.position(request.target),
            interactions: manager.pendingInteractions(request.target),
            ...(request.deliveryCommandId === undefined
                ? {}
                : {
                      delivery: {
                          commandId: request.deliveryCommandId,
                          standing: standings.standing(request.deliveryCommandId, request.target),
                      },
                  }),
        }),
    );
    // Outcomes retained across a restart are published once. The sink keeps them until the Relay connects,
    // and a later reconnect does not replay events it already sent. An outcome the previous process recorded is
    // restated as the outcome it recorded, so status notifications do not take it for a new one. An archived Session
    // keeps its receipts, so none of its command IDs runs twice, but it has no event log and nobody can read it, so
    // its outcomes settle without being published.
    const held = new NativeSessionSet();
    for (const session of sessionStore.list()) {
        held.add(session.target);
    }
    for (const recovered of operations.recover()) {
        if (!held.has(recovered.target)) {
            continue;
        }
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
        standings,
    };
}
