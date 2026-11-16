import { UnavailableAgent } from "../../agent/discovery/agent-discovery.ts";
import { AgentProbeError } from "../../agent/discovery/agent-probe-error.ts";
import {
    type DiscoverLocalAgentInventoryOptions,
    discoverLocalAgentInventory,
} from "../../agent/discovery/discover-local-agents.ts";
import { ProcessExecutionError } from "../../util/process/process-error.ts";
import { RuntimeDiagnosticLog } from "../observability/diagnostic-log.ts";

function failureDetails(failure: unknown): Readonly<Record<string, string>> {
    const fields: Record<string, string> = {};
    let current = failure;
    for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
        const prefix = depth === 0 ? "failure" : `cause${depth.toString()}`;
        if (current instanceof ProcessExecutionError || current instanceof AgentProbeError) {
            fields[`${prefix}Name`] =
                current instanceof ProcessExecutionError ? "ProcessExecutionError" : "AgentProbeError";
            fields[`${prefix}Code`] = current.code;
        } else {
            fields[`${prefix}Name`] = "Error";
        }
        if (depth === 0 && current instanceof ProcessExecutionError) {
            Object.assign(fields, current.diagnosticDetails);
        }
        current = current.cause;
    }
    return fields;
}

export async function discoverRuntimeAgentInventory(options: DiscoverLocalAgentInventoryOptions, computerId: string) {
    const log = new RuntimeDiagnosticLog(options.dataDirectory);
    const record = (details: Readonly<Record<string, string | number>>): void => {
        log.record(
            `Morty agent discovery diagnostic ${JSON.stringify({
                timestamp: new Date().toISOString(),
                computerId,
                ...details,
            })}`,
        );
    };
    const inventory = await discoverLocalAgentInventory({
        ...options,
        onProbeDiagnostic: ({ failure, ...diagnostic }) => {
            // Never persist raw process output, error messages, arguments, paths or environment values.
            record({ ...diagnostic, ...failureDetails(failure) });
        },
    });
    for (const { discovery, detectionMilliseconds } of inventory.results) {
        record({
            event: "agent_discovery_result",
            harness: discovery.specification.harness,
            code: discovery instanceof UnavailableAgent ? discovery.code : "ready",
            source: discovery.status,
            elapsedMilliseconds: detectionMilliseconds,
        });
    }
    return inventory;
}
