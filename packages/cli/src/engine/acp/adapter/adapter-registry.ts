import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import { AcpContentExternalizer } from "../content/content-externalizer.ts";
import type { Adapter, AdapterDependencies, AdapterResolver } from "../native-history/preview-contract.ts";

/** Stable adapters retain preview state while query definitions follow catalog rediscovery. */
export class AdapterRegistry {
    readonly #resolve: AdapterResolver;
    readonly #dependencies: AdapterDependencies;
    readonly #adapters = new Map<string, Adapter>();

    constructor(resolve: AdapterResolver, dependencies: AdapterDependencies) {
        this.#resolve = resolve;
        this.#dependencies = dependencies;
    }

    readonly resolve = (agent: AcpAgentDefinition): Adapter => {
        const existing = this.#adapters.get(agent.harness);
        if (existing !== undefined) {
            existing.refreshAgent(agent);
            return existing;
        }
        const adapter = this.#resolve(agent, this.#dependencies);
        this.#adapters.set(agent.harness, adapter);
        return adapter;
    };

    readonly close = async (): Promise<void> => {
        await Promise.all([...this.#adapters.values()].map((adapter) => adapter.close()));
        this.#adapters.clear();
    };
}

export function createRuntimeAdapterRegistry(
    adapters: AdapterResolver,
    processes: AdapterDependencies["processes"],
    externalize: ConstructorParameters<typeof AcpContentExternalizer>[0],
    linkedResources: ConstructorParameters<typeof AcpContentExternalizer>[1],
) {
    const contentExternalizer = new AcpContentExternalizer(externalize, linkedResources);
    return {
        adapters: new AdapterRegistry(adapters, { processes, contentExternalizer }),
        externalizeSessionUpdate: contentExternalizer.update,
    };
}
