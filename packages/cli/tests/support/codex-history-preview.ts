import { validateAgentRuntime } from "../../src/engine/acp/adapter/agent-initialization.ts";
import { CodexAdapter } from "../../src/engine/acp/adapter/codex/adapter.ts";
import type { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import type { AdapterSessionCreateParams } from "../../src/engine/acp/native-history/preview-contract.ts";
import { MemorySessionEventStore } from "../../src/engine/session/history/session-event-store.ts";
import { AgentProcessPool } from "../../src/engine/session/process/agent-process-pool.ts";
import { UnretainedExternalContentStore } from "./unretained-external-content-store.ts";

export function codexHistoryAdapter(agent: AcpAgentDefinition) {
    const processes = new AgentProcessPool();
    const content = new UnretainedExternalContentStore();
    const adapter = new CodexAdapter(agent, {
        processes,
        contentExternalizer: new AcpContentExternalizer((sessionTarget, value, signal) =>
            content.put({
                bytes: value.bytes,
                kind: value.kind,
                mediaType: value.mediaType,
                name: value.name,
                target: sessionTarget,
                signal,
            }),
        ),
    });
    return { adapter, processes };
}

/** Exercises the production preview boundary against a controlled app-server executable. */
export async function previewCodexHistory(
    agent: AcpAgentDefinition,
    cwd: string,
    sessionId: string,
    signal: AbortSignal,
) {
    const { adapter, processes } = codexHistoryAdapter(agent);
    try {
        return await adapter.readSessionHistory({
            query: { agent, cwd, signal },
            request: {
                sessionId,
                eventLimit: 500,
                cursor: null,
            },
        });
    } finally {
        await adapter.close();
        await processes.stopIdleReclamation();
    }
}

/** Reads through the normal ACP session/load lifecycle for parity assertions. */
export async function loadCodexHistory(agent: AcpAgentDefinition, cwd: string, sessionId: string, signal: AbortSignal) {
    const { adapter, processes } = codexHistoryAdapter(agent);
    const events = new MemorySessionEventStore();
    const sessionTarget = { harness: agent.harness, sessionId };
    try {
        await validateAgentRuntime(agent, signal);
        const rejectInteraction = async (): Promise<never> => {
            throw new Error("History replay must not request interaction");
        };
        const params: AdapterSessionCreateParams = {
            scope: { agent, cwd },
            signal,
            onSessionEvent: async (_sessionId, event) => {
                events.append(sessionTarget, { type: "acp", payload: event.payload });
            },
            interactions: {
                onPermission: rejectInteraction,
                onElicitation: rejectInteraction,
                onElicitationComplete: rejectInteraction,
            },
        };
        try {
            events.reset(sessionTarget);
            await adapter.openSessionWithReplay({ ...params, sessionId });
            signal.throwIfAborted();
            return events.page(sessionTarget, 500, null);
        } finally {
            await adapter.releaseSession({
                cwd,
                sessionId,
                signal: AbortSignal.timeout(30_000),
            });
        }
    } finally {
        try {
            await adapter.close();
        } finally {
            events.close();
            await processes.stopIdleReclamation();
        }
    }
}
