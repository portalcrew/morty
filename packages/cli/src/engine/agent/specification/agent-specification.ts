import type { SessionCapabilities } from "@portalcrew/morty-client/protocol";
import type { ResolvedExecutable } from "../../util/process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../discovery/agent-discovery-context.ts";
import type { AgentReadinessProbeParams } from "../discovery/agent-readiness.ts";

// A probe budget is the computer's worst-case allowance, not an optimistic guess. An Agent that is
// installed and healthy must not be reclassified as missing just because a cold start, a first-run
// package unpack, or a busy host pushed a single `--version` past a tight deadline. These values are
// deliberately generous; the caller's own deadline (Agent discovery, settings discovery) remains the
// backstop that stops a genuinely hung executable.
const VERSION_PROBE_TIMEOUT_MILLISECONDS = 30_000;
const ACP_PROBE_TIMEOUT_MILLISECONDS = 60_000;

export abstract class LocalAgentSpecification {
    abstract readonly probeReadiness: (params: AgentReadinessProbeParams) => Promise<SessionCapabilities>;
    abstract readonly agentExecutable: string;
    readonly agentOverrideVariable: string;

    protected constructor(executableOverrideVariable: string) {
        this.agentOverrideVariable = executableOverrideVariable;
    }
    abstract readonly harness: string;
    abstract readonly label: string;
    readonly minimumSupportedAgentVersion: string = "0.0.0";
    readonly acpProbeTimeoutMilliseconds: number = ACP_PROBE_TIMEOUT_MILLISECONDS;
    readonly authenticationCommand = (): string => "";
    readonly versionProbeTimeoutMilliseconds: number = VERSION_PROBE_TIMEOUT_MILLISECONDS;

    readonly createLaunchEnvironment = async (
        _context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => Object.freeze({});

    readonly resolveInstalledAgentExecutables = (
        _context: LocalAgentDiscoveryContext,
    ): Promise<readonly ResolvedExecutable[]> => Promise.resolve([]);
}
