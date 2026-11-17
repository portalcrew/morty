import type { MortyClient } from "@portalcrew/morty-client";
import type { NativeSessionTarget, SessionLiveEvent } from "@portalcrew/morty-client/protocol";
import type { StoreApi } from "zustand/vanilla";
import type { LiveExecutionChange, SessionExecutionFact, SessionExecutionStore } from "./session-execution.ts";
import { type SessionLifecycleFact, sessionLifecycleFact } from "./session-lifecycle.ts";

/** What the pane's connection tells the Session's execution state: live lifecycle events and reads of the Computer. */
export interface SessionExecutionFeed {
    /** Reads the Session's execution; `deliveryCommandId` asks the Computer where that command stands too. */
    readonly read: (connected: MortyClient, signal: AbortSignal, deliveryCommandId?: string) => Promise<void>;
    readonly receive: (event: SessionLiveEvent, connected: MortyClient, signal: AbortSignal) => Promise<void>;
}

export function createSessionExecutionFeed(options: {
    readonly sessionTarget: NativeSessionTarget;
    readonly execution: StoreApi<SessionExecutionStore>;
    /** The command whose execution a command's message belongs to, or null when the history does not tell. */
    readonly executionOwner: (commandId: string) => string | null;
}): SessionExecutionFeed {
    const { sessionTarget, execution } = options;
    const liveChange = (fact: SessionLifecycleFact, event: SessionLiveEvent): LiveExecutionChange | null => {
        switch (fact.kind) {
            case "interaction-requested":
            case "permission-resolved":
            case "elicitation-resolved":
            case "queue-changed":
            case "turn-stop-changed":
                return fact;
            case "turn-started": {
                const owner = options.executionOwner(fact.commandId);
                return {
                    kind: "turn-started",
                    commandId: fact.commandId,
                    startedAt: Date.parse(event.recordedAt),
                    steers: owner !== null && owner !== fact.commandId,
                };
            }
            case "turn-delegated":
                return { ...fact, at: Date.parse(event.recordedAt) };
            case "turn-completed":
                return {
                    kind: "turn-ended",
                    commandId: fact.commandId,
                    outcome: fact.steered ? { kind: "steered" } : { kind: "completed" },
                };
            case "turn-failed":
                return {
                    kind: "turn-ended",
                    commandId: fact.commandId,
                    outcome: { kind: "failed", failure: { code: fact.code, message: fact.message } },
                };
            case "none":
                return null;
            default:
                return fact satisfies never;
        }
    };
    const read = async (connected: MortyClient, signal: AbortSignal, deliveryCommandId?: string): Promise<void> => {
        const snapshot = await connected.sessions.readSessionExecution(sessionTarget, signal, deliveryCommandId);
        signal.throwIfAborted();
        await observe({ kind: "read", snapshot }, connected, signal);
    };
    const observe = async (fact: SessionExecutionFact, connected: MortyClient, signal: AbortSignal): Promise<void> => {
        if (
            execution
                .getState()
                .apply(fact)
                .some((effect) => effect.kind === "read")
        ) {
            await read(connected, signal);
        }
    };
    return {
        read,
        receive: async (event, connected, signal) => {
            if (event.type === "acp") {
                return;
            }
            const change = liveChange(sessionLifecycleFact(event.payload), event);
            if (change !== null) {
                await observe(
                    { kind: "live", sessionGenerationId: event.sessionGenerationId, position: event.position, change },
                    connected,
                    signal,
                );
            }
        },
    };
}
