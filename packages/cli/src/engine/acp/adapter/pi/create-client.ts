import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { PiAcpAgent } from "../../harness/pi/upstream/dist/acp/agent.js";
import type { PiAcpClient } from "../../harness/pi/upstream/dist/acp/client.js";
import { validateAgentRuntime } from "../agent-initialization.ts";
import { piProcessHost } from "./process-host.ts";

export type PiClientRuntime = Pick<AcpAgentDefinition, "agentIdentity" | "command" | "environment">;

/** Constructs a Pi agent for operations that never launch Pi, such as capabilities and session listing. */
export function createPiCatalogClient(runtime: PiClientRuntime, callbacks: PiAcpClient): PiAcpAgent {
    return new PiAcpAgent(callbacks, { environment: piEnvironment(runtime), processes: piProcessHost });
}

/** Revalidate the local launch target immediately before constructing a client that may launch Pi. */
export async function createPiClient(
    runtime: PiClientRuntime,
    callbacks: PiAcpClient,
    signal: AbortSignal,
): Promise<PiAcpAgent> {
    await validateAgentRuntime(runtime, signal);
    signal.throwIfAborted();
    return new PiAcpAgent(callbacks, { environment: piEnvironment(runtime), processes: piProcessHost });
}

function piEnvironment(runtime: PiClientRuntime): Readonly<NodeJS.ProcessEnv> {
    return Object.freeze({ ...process.env, ...runtime.environment, PI_ACP_PI_COMMAND: runtime.command });
}
