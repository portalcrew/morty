import { AcpExecutionError } from "../../acp-error.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { CodexAcpAgent } from "../../harness/codex/agent.ts";
import type { CodexClientOptions } from "../../harness/codex/session-update.ts";
import { connectSharedCodex } from "../../harness/codex/shared-server.ts";
import { RetryableAcpInitializationError, validateAgentRuntime } from "../agent-initialization.ts";

export async function createCodexClient(
    agent: AcpAgentDefinition,
    options: Omit<CodexClientOptions, "command" | "environment">,
    signal: AbortSignal,
    existingThread?: string,
): Promise<CodexAcpAgent> {
    if (agent.harness !== "codex") {
        throw new AcpExecutionError("The Codex adapter cannot use another agent.", {}, "agent_adapter_mismatch");
    }
    await validateAgentRuntime(agent, signal);
    if (existingThread !== undefined) {
        const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
        const socket = await connectSharedCodex(agent.environment, probeSignal).catch(() => null);
        if (socket !== null) {
            const shared = new CodexAcpAgent({
                ...options,
                command: agent.command,
                environment: agent.environment,
                socket,
            });
            try {
                await shared.initialize(probeSignal);
                if (await shared.ownsSharedThread(existingThread, probeSignal)) {
                    return shared;
                }
            } catch {
                // Unreachable or incompatible shared daemon: preserve the existing private path.
            }
            await shared.dispose("graceful");
        }
        signal.throwIfAborted();
    }
    const client = new CodexAcpAgent({ ...options, command: agent.command, environment: agent.environment });
    try {
        await client.initialize(signal);
        signal.throwIfAborted();
        return client;
    } catch (cause) {
        await client.dispose("force");
        signal.throwIfAborted();
        throw new RetryableAcpInitializationError(cause);
    }
}
