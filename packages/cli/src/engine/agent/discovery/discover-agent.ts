import type { SessionCapabilities } from "@portalcrew/morty-client/protocol";
import { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import { unsupportedSessionCapabilities } from "../../acp/protocol/session-capabilities.ts";
import { ProcessExecutionError } from "../../util/process/executable.ts";
import type { LocalAgentSpecification } from "../specification/agent-specification.ts";
import {
    type AgentDiscovery,
    AgentProbeFailed,
    AuthenticationRequiredAgent,
    AvailableAgent,
    IncompatibleAdapter,
    MissingAgent,
    type UnavailableAgent,
    UnsupportedAgentVersion,
} from "./agent-discovery.ts";
import type { AgentProbeDiagnostic, LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import { AgentProbeError } from "./agent-probe-error.ts";
import { isAgentVersionSupported } from "./agent-version.ts";
import { probeVersion, resolveAgentExecutables } from "./executable-discovery.ts";

function agentProbeFailure(specification: LocalAgentSpecification, error: unknown): UnavailableAgent {
    if (error instanceof AgentProbeError) {
        return new AgentProbeFailed(specification, error.code, error.message);
    }
    if (error instanceof ProcessExecutionError) {
        const code = error.code === "process_timeout" ? "agent_probe_timeout" : "agent_probe_failed";
        return new AgentProbeFailed(specification, code, "Agent version probe failed");
    }
    return new AgentProbeFailed(specification, "agent_probe_failed", "Agent probe failed");
}

// A timeout says the probe lost a race, not that the Agent is absent or broken. Discovery runs while
// the host is doing other work, so reclassifying a healthy Agent as missing on one slow probe would
// silently drop it from the catalog. Retry the same probe once before reporting a failure; every
// other failure kind is deterministic and is reported immediately.
function isRetryableProbeFailure(error: unknown): boolean {
    if (error instanceof ProcessExecutionError) {
        return error.code === "process_timeout";
    }
    return error instanceof AgentProbeError && error.code === "adapter_probe_timeout";
}

async function probeWithRetry<Value>(
    context: LocalAgentDiscoveryContext,
    specification: LocalAgentSpecification,
    source: AgentProbeDiagnostic["source"],
    probe: () => Promise<Value>,
): Promise<Value> {
    const signal = context.signal;
    const run = async (attempt: number): Promise<Value> => {
        const startedAt = performance.now();
        try {
            return await probe();
        } catch (failure) {
            context.onProbeDiagnostic?.({
                harness: specification.harness,
                source,
                event: signal.aborted ? "agent_probe_cancelled" : "agent_probe_failed",
                attempt,
                elapsedMilliseconds: Math.round(performance.now() - startedAt),
                timeoutMilliseconds:
                    source === "acp_readiness"
                        ? specification.acpProbeTimeoutMilliseconds
                        : specification.versionProbeTimeoutMilliseconds,
                failure,
            });
            throw failure;
        }
    };
    try {
        return await run(1);
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        if (!isRetryableProbeFailure(error)) {
            throw error;
        }
        return await run(2);
    }
}

function integrationProbeFailure(specification: LocalAgentSpecification, error: unknown): UnavailableAgent {
    if (error instanceof AgentProbeError) {
        if (error.code === "authentication_required") {
            return new AuthenticationRequiredAgent(specification);
        }
        return error.code === "acp_incompatible"
            ? new IncompatibleAdapter(specification, error.message)
            : new AgentProbeFailed(specification, error.code, error.message);
    }
    if (error instanceof ProcessExecutionError) {
        const code = error.code === "process_timeout" ? "adapter_probe_timeout" : "adapter_probe_failed";
        return new AgentProbeFailed(specification, code, "Agent readiness probe failed");
    }
    return new AgentProbeFailed(specification, "adapter_probe_failed", "Agent readiness probe failed");
}

export async function discoverAgent(
    specification: LocalAgentSpecification,
    context: LocalAgentDiscoveryContext,
): Promise<AgentDiscovery> {
    context.signal.throwIfAborted();
    const agents = await resolveAgentExecutables(specification, context);
    if (agents.length === 0) {
        return new MissingAgent(specification);
    }

    let lastFailure: UnavailableAgent | null = null;
    for (const agent of agents) {
        let agentVersion = "";
        try {
            agentVersion = await probeWithRetry(
                context,
                specification,
                "agent_version",
                async () =>
                    await probeVersion(
                        agent,
                        context.environment,
                        context.defaultWorkspace,
                        context.signal,
                        specification.versionProbeTimeoutMilliseconds,
                    ),
            );
        } catch (error) {
            if (context.signal.aborted) {
                context.signal.throwIfAborted();
            }
            lastFailure = agentProbeFailure(specification, error);
            continue;
        }
        const supportedVersion = isAgentVersionSupported(agentVersion, specification.minimumSupportedAgentVersion);
        if (supportedVersion === null) {
            lastFailure = new AgentProbeFailed(
                specification,
                "agent_probe_failed",
                "Agent reported an unrecognized version",
            );
            continue;
        }
        if (!supportedVersion) {
            lastFailure = new UnsupportedAgentVersion(
                specification,
                agentVersion,
                specification.minimumSupportedAgentVersion,
            );
            continue;
        }
        try {
            const launchEnvironment = await specification.createLaunchEnvironment(context);
            const buildDefinition = (capabilities: SessionCapabilities): AcpAgentDefinition =>
                new AcpAgentDefinition(
                    specification.harness,
                    specification.label,
                    launchEnvironment,
                    agentVersion,
                    agent.identity,
                    capabilities,
                );
            const capabilities = await probeWithRetry(
                context,
                specification,
                "acp_readiness",
                async () =>
                    await specification.probeReadiness({
                        agent: buildDefinition(unsupportedSessionCapabilities()),
                        environment: context.environment,
                        defaultWorkspace: context.defaultWorkspace,
                        signal: context.signal,
                    }),
            );
            return new AvailableAgent(specification, buildDefinition(capabilities));
        } catch (error) {
            if (context.signal.aborted) {
                context.signal.throwIfAborted();
            }
            const failure = integrationProbeFailure(specification, error);
            if (failure instanceof AuthenticationRequiredAgent) {
                return failure;
            }
            lastFailure = failure;
        }
    }
    return lastFailure ?? new MissingAgent(specification);
}
