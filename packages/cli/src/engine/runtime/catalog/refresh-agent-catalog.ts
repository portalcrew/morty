import { type RuntimeConfig, withRuntimeEnvironment } from "../config.ts";
import { discoverRuntimeAgentInventory } from "./discover-agent-catalog.ts";
import { publishAgentCatalog } from "./publish-agent-catalog.ts";

/**
 * Re-reads the local Agent inventory and republishes the catalog, so Agents installed or signed in after the daemon
 * started become available without restarting it. The transition and publication commit together; a failed
 * publication keeps the previous catalog.
 */
export async function refreshAgentCatalog(config: RuntimeConfig, signal: AbortSignal) {
    const readyAgents = (await discoverConfiguredAgents(config, signal)).readyAgents();
    signal.throwIfAborted();
    return await config.catalog.replaceAndPublish(
        () => readyAgents.map((agent) => withRuntimeEnvironment(agent, config.localContext.agentLaunchEnvironment)),
        (publishSignal) => publishAgentCatalog(config, publishSignal),
        signal,
    );
}

export async function discoverConfiguredAgents(config: RuntimeConfig, signal: AbortSignal) {
    return await discoverRuntimeAgentInventory(
        {
            defaultWorkspace: config.defaultWorkspace,
            dataDirectory: config.localContext.stateDirectory,
            environment: config.localContext.agentLaunchEnvironment,
            signal,
        },
        config.computerId,
    );
}
