import type { AcpAgentDefinition } from "../acp/agent/agent-definition.ts";
import { OperationError } from "../infra/operation-error.ts";
import { SerialTaskQueue } from "../util/serial-task-queue.ts";

/** The launch definition of a cataloged Agent, as the computer names it. */
export type CatalogAgent = AcpAgentDefinition;

class LocalAgentCatalogError extends OperationError {
    constructor() {
        super("agent_not_ready", "The requested local Agent is not ready");
        this.name = "LocalAgentCatalogError";
    }
}

export class LocalAgentCatalog {
    #agents: readonly AcpAgentDefinition[];
    readonly #updates = new SerialTaskQueue();

    constructor(agents: readonly AcpAgentDefinition[]) {
        this.#agents = this.validate(agents);
    }

    readonly find = (harness: string): AcpAgentDefinition => {
        for (const agent of this.#agents) {
            if (agent.harness === harness) {
                return agent;
            }
        }
        throw new LocalAgentCatalogError();
    };

    readonly read = (): readonly AcpAgentDefinition[] => this.#agents;

    /** Serializes replacements and publication; a failed publication restores only its own prior snapshot. */
    readonly replaceAndPublish = async (
        build: (current: readonly CatalogAgent[]) => readonly CatalogAgent[],
        publish: (signal: AbortSignal) => Promise<void>,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#updates.run(async (updateSignal) => {
            const previous = this.#agents;
            this.#agents = this.validate(build(previous));
            try {
                await publish(updateSignal);
            } catch (error) {
                this.#agents = previous;
                throw error;
            }
        }, signal);
    };

    private readonly validate = (agents: readonly AcpAgentDefinition[]): readonly AcpAgentDefinition[] => {
        const identifiers = new Set<string>();
        for (const agent of agents) {
            if (identifiers.has(agent.harness)) {
                throw new Error("The local Agent catalog contains duplicate entries");
            }
            identifiers.add(agent.harness);
        }
        return Object.freeze([...agents]);
    };
}
