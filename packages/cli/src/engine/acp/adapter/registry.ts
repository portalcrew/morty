import { AcpExecutionError } from "../acp-error.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { Adapter, AdapterDependencies, AdapterResolver } from "../native-history/preview-contract.ts";
import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import { PiAdapter } from "./pi/adapter.ts";

export const harnessAdapters: AdapterResolver = (
    agent: AcpAgentDefinition,
    dependencies: AdapterDependencies,
): Adapter => {
    switch (agent.harness) {
        case "codex":
            return new CodexAdapter(agent, dependencies);
        case "claude":
            return new ClaudeAdapter(agent, dependencies);
        case "pi":
            return new PiAdapter(agent, dependencies);
        default:
            throw new AcpExecutionError(
                `Agent "${agent.harness}" has no registered harness adapter.`,
                {},
                "agent_adapter_not_found",
            );
    }
};
