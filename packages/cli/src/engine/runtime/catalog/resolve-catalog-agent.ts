import type { CatalogAgent as CatalogAgentDefinition } from "../../agent/catalog.ts";
import type { discoverLocalAgentInventory } from "../../agent/discovery/discover-local-agents.ts";
import { revalidateExecutable } from "../../util/process/executable.ts";
import { type RuntimeConfig, withRuntimeEnvironment } from "../config.ts";

export async function resolveCatalogAgent(
    config: RuntimeConfig,
    harness: string,
    signal: AbortSignal,
): Promise<CatalogAgentDefinition> {
    const agent = config.catalog.find(harness);
    return await config.resolveAgent(agent, signal);
}

type DiscoverInventory = (signal: AbortSignal) => Promise<Awaited<ReturnType<typeof discoverLocalAgentInventory>>>;
type PublishCatalog = (config: RuntimeConfig, signal: AbortSignal) => Promise<void>;

/**
 * Resolves the Agent definition a command should run against. The cataloged snapshot is served
 * while its executables still match discovery; once an upgrade replaces them, the Agent is
 * re-discovered and the catalog entry is swapped so new conversations and settings discovery use
 * the upgraded computer. A failed publication rolls the swap back, keeping the relay-facing catalog
 * consistent with what this daemon would actually spawn. Concurrent commands for the same Agent
 * share one refresh instead of racing probes against the same binary, and the swap commits
 * through the catalog's serialized replacement so it neither overlaps nor clobbers a full discovery.
 */
export function createCatalogAgentResolver(
    discover: DiscoverInventory,
    readConfig: () => RuntimeConfig,
    publish: PublishCatalog,
): RuntimeConfig["resolveAgent"] {
    const swaps = new Map<string, Promise<void>>();
    return async (agent, signal) => {
        const config = readConfig();
        const pending = swaps.get(agent.harness);
        if (pending !== undefined) {
            await pending;
            return config.catalog.find(agent.harness);
        }
        let release = (): void => undefined;
        const gate = new Promise<void>((resolveGate) => {
            release = resolveGate;
        });
        swaps.set(agent.harness, gate);
        try {
            if (await unchangedIdentity(agent, signal)) {
                return agent;
            }
            signal.throwIfAborted();
            const inventory = await discover(signal);
            signal.throwIfAborted();
            const rediscovered = inventory
                .readyAgents()
                .filter((ready) => ready.harness === agent.harness)
                .map((ready) => withRuntimeEnvironment(ready, config.localContext.agentLaunchEnvironment));
            await config.catalog.replaceAndPublish(
                (current) => {
                    if (!current.some((entry) => entry.harness === agent.harness)) {
                        throw new Error(
                            `The local Agent ${agent.harness} left the catalog before its refresh completed`,
                        );
                    }
                    return [...current.filter((entry) => entry.harness !== agent.harness), ...rediscovered];
                },
                (publishSignal) => publish(config, publishSignal),
                signal,
            );
            return config.catalog.find(agent.harness);
        } finally {
            swaps.delete(agent.harness);
            release();
        }
    };
}

async function unchangedIdentity(agent: CatalogAgentDefinition, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const unchanged = await revalidateExecutable(agent.agentIdentity);
    signal.throwIfAborted();
    return unchanged;
}
