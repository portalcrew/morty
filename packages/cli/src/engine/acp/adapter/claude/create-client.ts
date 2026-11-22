import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { spawnClaudeWithParentLifeline } from "../../harness/claude/parent-lifeline.ts";
import { type AcpClient, ClaudeAcpAgent } from "../../harness/claude/upstream/dist/acp-agent.js";
import { validateAgentRuntime } from "../agent-initialization.ts";

export type ClaudeClientRuntime = Pick<AcpAgentDefinition, "agentIdentity" | "command" | "environment">;

export function createClaudeCatalogClient(
    runtime: ClaudeClientRuntime,
    callbacks: AcpClient,
    onBackgroundActivity?: (activity: "none" | "running" | "awaiting-results") => void,
): ClaudeAcpAgent {
    return new ClaudeAcpAgent(
        callbacks,
        undefined,
        Object.freeze({
            ...process.env,
            ...runtime.environment,
            CLAUDE_CODE_EXECUTABLE: runtime.command,
            // Persist the submitted prompt before model output so a retired process can be resumed.
            CLAUDE_CODE_EAGER_FLUSH: "1",
        }),
        spawnClaudeWithParentLifeline,
        onBackgroundActivity,
    );
}

export async function createClaudeClient(
    runtime: ClaudeClientRuntime,
    callbacks: AcpClient,
    signal: AbortSignal,
    onBackgroundActivity?: (activity: "none" | "running" | "awaiting-results") => void,
): Promise<ClaudeAcpAgent> {
    await validateAgentRuntime(runtime, signal);
    signal.throwIfAborted();
    return createClaudeCatalogClient(runtime, callbacks, onBackgroundActivity);
}

export const initializeClaudeClient = (agent: ClaudeAcpAgent) =>
    agent.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "morty", version: "0.0.3" },
        clientCapabilities: {
            elicitation: { form: {}, url: {} },
            session: { compaction: {}, configOptions: { boolean: {} }, promptSuggestions: {} },
        },
    });
