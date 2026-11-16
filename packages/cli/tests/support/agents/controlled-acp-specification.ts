import type { AgentConnectionFactory } from "./agent-connection.ts";
import { ControlledAcpConnection } from "./controlled-acp-connection.ts";
import { ControlledReadinessSpecification } from "./controlled-readiness-specification.ts";

export abstract class ControlledAcpSpecification extends ControlledReadinessSpecification {
    readonly launchArguments: readonly string[];
    readonly createConnection: AgentConnectionFactory = (options) =>
        new ControlledAcpConnection(
            {
                harness: this.harness,
                adapterPath: options.command,
                arguments: this.launchArguments,
                environment: options.environment,
            },
            options,
        );

    protected constructor(executableOverrideVariable: string, launchArguments: readonly string[]) {
        super(executableOverrideVariable);
        this.launchArguments = Object.freeze([...launchArguments]);
    }
}
