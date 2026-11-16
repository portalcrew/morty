import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import type { SessionCapabilities } from "@portalcrew/morty-client/protocol";
import { createClaudeClient, initializeClaudeClient } from "../../../acp/adapter/claude/create-client.ts";
import { waitForAgentOperation } from "../../../acp/connection/agent-operation.ts";
import { normalizeAcpCapabilities } from "../../../acp/protocol/session-capabilities.ts";
import { hostPlatform } from "../../../util/platform/index.ts";
import { type ResolvedExecutable, resolveExecutablePath } from "../../../util/process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../../discovery/agent-discovery-context.ts";
import { AgentProbeError } from "../../discovery/agent-probe-error.ts";
import { type AgentReadinessProbeParams, filterEnvironment } from "../../discovery/agent-readiness.ts";
import { LocalAgentSpecification } from "../agent-specification.ts";

export class ClaudeCodeAgentSpecification extends LocalAgentSpecification {
    readonly agentExecutable = "claude";
    readonly harness = "claude";
    readonly label = "Claude Code";
    override readonly minimumSupportedAgentVersion = "2.1.273";

    constructor() {
        super("MORTY_CLAUDE_PATH");
    }

    override readonly probeReadiness = async (params: AgentReadinessProbeParams): Promise<SessionCapabilities> => {
        const timeout = AbortSignal.timeout(this.acpProbeTimeoutMilliseconds);
        const signal = AbortSignal.any([params.signal, timeout]);
        const reject = async (): Promise<never> => {
            throw new AgentProbeError("acp_incompatible", "The Claude readiness probe does not accept interactions");
        };
        try {
            const client = await createClaudeClient(
                params.agent.withEnvironment({ ...filterEnvironment(params.environment), ...params.agent.environment }),
                {
                    sessionUpdate: reject,
                    requestPermission: reject,
                    createElicitation: reject,
                    completeElicitation: reject,
                    readTextFile: reject,
                    writeTextFile: reject,
                    extNotification: reject,
                },
                signal,
            );
            try {
                const initialized = await waitForAgentOperation(initializeClaudeClient(client), signal);
                if (initialized.protocolVersion !== PROTOCOL_VERSION) {
                    throw new AgentProbeError("acp_incompatible", "Claude selected an unsupported protocol version");
                }
                return normalizeAcpCapabilities(initialized);
            } finally {
                await client.dispose("graceful");
            }
        } catch (cause) {
            params.signal.throwIfAborted();
            if (timeout.aborted) {
                throw new AgentProbeError("adapter_probe_timeout", "Claude readiness probe timed out", { cause });
            }
            if (cause instanceof AgentProbeError) {
                throw cause;
            }
            throw new AgentProbeError("acp_incompatible", "Claude initialization failed", { cause });
        }
    };

    override readonly resolveInstalledAgentExecutables = async (
        context: LocalAgentDiscoveryContext,
    ): Promise<readonly ResolvedExecutable[]> => {
        context.signal.throwIfAborted();
        const paths = hostPlatform.claudeCodeExecutablePaths(context.environment);
        const executables: ResolvedExecutable[] = [];
        for (const path of paths) {
            const executable = await resolveExecutablePath(path);
            context.signal.throwIfAborted();
            if (executable !== null) {
                executables.push(executable);
            }
        }
        return executables;
    };
}
