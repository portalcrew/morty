import { realpathSync, statSync } from "node:fs";
import type { SessionCapabilities } from "@portalcrew/morty-client/protocol";
import { AcpAgentDefinition } from "../../src/engine/acp/agent/agent-definition.ts";
import { unsupportedSessionCapabilities } from "../../src/engine/acp/protocol/session-capabilities.ts";
import { ExecutableIdentity } from "../../src/engine/util/process/executable.ts";

/** The identity of a local executable file as it is now. */
export function readExecutableIdentity(path: string): ExecutableIdentity {
    const resolvedPath = realpathSync(path);
    const metadata = statSync(resolvedPath);
    return new ExecutableIdentity(
        resolvedPath,
        resolvedPath,
        metadata.dev,
        metadata.ino,
        metadata.size,
        metadata.ctimeMs,
    );
}

/** A local Agent definition as discovery would build it for `command`, without probing the Agent. */
export function testAgentDefinition(
    harness: string,
    label: string,
    command: string,
    environment: Readonly<Record<string, string>> = {},
    agentVersion = "",
    capabilities: SessionCapabilities = unsupportedSessionCapabilities(),
): AcpAgentDefinition {
    return new AcpAgentDefinition(
        harness,
        label,
        environment,
        agentVersion,
        readExecutableIdentity(command),
        capabilities,
    );
}
