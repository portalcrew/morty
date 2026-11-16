import type { SessionCapabilities } from "@portalcrew/morty-client/protocol";
import type { ExecutableIdentity } from "../../util/process/executable.ts";

export class AcpAgentDefinition {
    readonly agentIdentity: ExecutableIdentity;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly command: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly harness: string;
    readonly label: string;

    constructor(
        harness: string,
        label: string,
        environment: Readonly<Record<string, string>>,
        agentVersion: string,
        agentIdentity: ExecutableIdentity,
        capabilities: SessionCapabilities,
    ) {
        this.agentIdentity = agentIdentity;
        this.agentVersion = agentVersion;
        this.capabilities = Object.freeze({ ...capabilities });
        this.command = agentIdentity.realPath;
        this.environment = Object.freeze({ ...environment });
        this.harness = harness;
        this.label = label;
    }

    readonly withEnvironment = (environment: Readonly<Record<string, string>>): AcpAgentDefinition =>
        new AcpAgentDefinition(
            this.harness,
            this.label,
            environment,
            this.agentVersion,
            this.agentIdentity,
            this.capabilities,
        );
}
