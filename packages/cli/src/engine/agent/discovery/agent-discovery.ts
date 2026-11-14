import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { LocalAgentSpecification } from "../specification/agent-specification.ts";

export abstract class AgentDiscovery {
    readonly specification: LocalAgentSpecification;
    abstract readonly status: string;

    constructor(specification: LocalAgentSpecification) {
        this.specification = specification;
    }
}

export class AvailableAgent extends AgentDiscovery {
    readonly agent: AcpAgentDefinition;
    readonly status = "ready";

    constructor(specification: LocalAgentSpecification, agent: AcpAgentDefinition) {
        super(specification);
        this.agent = agent;
    }
}

export abstract class UnavailableAgent extends AgentDiscovery {
    abstract readonly code: string;
    abstract readonly message: string;
}

export class MissingAgent extends UnavailableAgent {
    readonly code = "agent_not_found";
    readonly message = "Agent executable not found";
    readonly status = "missing_agent";
}

export class AgentProbeFailed extends UnavailableAgent {
    readonly code: string;
    readonly message: string;
    readonly status = "probe_failed";

    constructor(specification: LocalAgentSpecification, code: string, message: string) {
        super(specification);
        this.code = code;
        this.message = message;
    }
}

export class UnsupportedAgentVersion extends UnavailableAgent {
    readonly agentVersion: string;
    readonly code = "agent_version_unsupported";
    readonly message: string;
    readonly minimumSupportedVersion: string;
    readonly status = "unsupported_version";

    constructor(specification: LocalAgentSpecification, agentVersion: string, minimumSupportedVersion: string) {
        super(specification);
        this.agentVersion = agentVersion;
        this.minimumSupportedVersion = minimumSupportedVersion;
        this.message = `Agent version ${agentVersion} is below the minimum supported version ${minimumSupportedVersion}`;
    }
}

export class IncompatibleAdapter extends UnavailableAgent {
    readonly code = "acp_incompatible";
    readonly message: string;
    readonly status = "incompatible_adapter";

    constructor(specification: LocalAgentSpecification, message: string) {
        super(specification);
        this.message = message;
    }
}

export class AuthenticationRequiredAgent extends UnavailableAgent {
    readonly code = "authentication_required";
    readonly message = "Agent authentication is required";
    readonly status = "authentication_required";
}

export class AgentDiscoveryResult {
    readonly detectionMilliseconds: number;
    readonly discovery: AgentDiscovery;

    constructor(discovery: AgentDiscovery, detectionMilliseconds: number) {
        if (!Number.isFinite(detectionMilliseconds) || detectionMilliseconds < 0) {
            throw new Error("The Agent detection duration is invalid");
        }
        this.detectionMilliseconds = Math.round(detectionMilliseconds * 1_000) / 1_000;
        this.discovery = discovery;
    }
}

export class LocalAgentInventory {
    readonly available: readonly AvailableAgent[];
    readonly results: readonly AgentDiscoveryResult[];
    readonly unavailable: readonly UnavailableAgent[];

    constructor(results: readonly AgentDiscoveryResult[]) {
        const discoveries = results.map((result) => result.discovery);
        const available: AvailableAgent[] = [];
        const unavailable: UnavailableAgent[] = [];
        for (const discovery of discoveries) {
            if (discovery instanceof AvailableAgent) {
                available.push(discovery);
            } else if (discovery instanceof UnavailableAgent) {
                unavailable.push(discovery);
            } else {
                throw new Error("Unsupported Agent discovery outcome");
            }
        }
        this.available = Object.freeze(available);
        this.results = Object.freeze([...results]);
        this.unavailable = Object.freeze(unavailable);
    }

    readonly detectionMillisecondsFor = (discovery: AgentDiscovery): number => {
        for (const result of this.results) {
            if (result.discovery === discovery) {
                return result.detectionMilliseconds;
            }
        }
        throw new Error("The Agent discovery result is unavailable");
    };

    readonly readyAgents = (): readonly AcpAgentDefinition[] => this.available.map((discovery) => discovery.agent);
}
