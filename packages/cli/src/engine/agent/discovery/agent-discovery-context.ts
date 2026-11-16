export interface AgentProbeDiagnostic {
    readonly harness: string;
    readonly source: "agent_version" | "acp_readiness";
    readonly event: "agent_probe_failed" | "agent_probe_cancelled";
    readonly attempt: number;
    readonly elapsedMilliseconds: number;
    readonly timeoutMilliseconds: number;
    readonly failure: unknown;
}

export interface LocalAgentDiscoveryContext {
    readonly dataDirectory: string;
    readonly defaultWorkspace: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly onProbeDiagnostic?: (diagnostic: AgentProbeDiagnostic) => void;
    readonly signal: AbortSignal;
}
