import { createHash } from "node:crypto";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import type { SessionCapabilities } from "@portalcrew/morty-client/protocol";
import { AcpExecutionError } from "../../../acp/acp-error.ts";
import { createPiClient } from "../../../acp/adapter/pi/create-client.ts";
import { agentOperationError, waitForAgentOperation } from "../../../acp/connection/agent-operation.ts";
import { normalizeAcpCapabilities } from "../../../acp/protocol/session-capabilities.ts";
import type { LocalAgentDiscoveryContext } from "../../discovery/agent-discovery-context.ts";
import { AgentProbeError } from "../../discovery/agent-probe-error.ts";
import { type AgentReadinessProbeParams, filterEnvironment } from "../../discovery/agent-readiness.ts";
import { LocalAgentSpecification } from "../agent-specification.ts";

const ACP_PROBE_TIMEOUT_MILLISECONDS = 30_000;

export class PiAgentSpecification extends LocalAgentSpecification {
    override readonly acpProbeTimeoutMilliseconds = ACP_PROBE_TIMEOUT_MILLISECONDS;
    readonly agentExecutable = "pi";

    /** Discovery exercises the same concrete Pi client as live operations, without local ACP dispatch. */
    override readonly probeReadiness = async (params: AgentReadinessProbeParams): Promise<SessionCapabilities> => {
        const timeout = AbortSignal.timeout(this.acpProbeTimeoutMilliseconds);
        const signal = AbortSignal.any([params.signal, timeout]);
        const runtime = {
            agentIdentity: params.agent.agentIdentity,
            command: params.agent.command,
            environment: Object.freeze({ ...filterEnvironment(params.environment), ...params.agent.environment }),
        };
        const rejectInteraction = async (): Promise<never> => {
            throw new AgentProbeError("acp_incompatible", "The Pi readiness probe does not accept interactions");
        };
        try {
            const client = await createPiClient(
                runtime,
                {
                    sessionUpdate: async () => undefined,
                    startUserMessage: () => undefined,
                    requestPermission: rejectInteraction,
                    requestElicitation: rejectInteraction,
                },
                signal,
            );
            try {
                const initialized = await client.initialize({
                    protocolVersion: PROTOCOL_VERSION,
                    clientCapabilities: {},
                });
                if (
                    initialized.protocolVersion !== PROTOCOL_VERSION ||
                    initialized.agentCapabilities?.loadSession !== true
                ) {
                    throw new AgentProbeError(
                        "acp_incompatible",
                        "Pi does not support the required native session contract",
                    );
                }
                const session = await waitForAgentOperation(
                    client.newSession({ cwd: params.defaultWorkspace, mcpServers: [] }),
                    signal,
                );
                if (session.sessionId.length === 0) {
                    throw new AgentProbeError("acp_incompatible", "Pi returned an invalid native session");
                }
                const result = await waitForAgentOperation(
                    client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "/session" }] }),
                    signal,
                );
                if (result.stopReason !== "end_turn") {
                    throw new AgentProbeError("acp_incompatible", "Pi did not complete its readiness turn");
                }
                return normalizeAcpCapabilities(initialized);
            } finally {
                await client.dispose();
            }
        } catch (cause) {
            params.signal.throwIfAborted();
            if (timeout.aborted) {
                throw new AgentProbeError("adapter_probe_timeout", "Pi readiness probe timed out", { cause });
            }
            const failure = agentOperationError(cause);
            if (failure instanceof AgentProbeError) {
                throw failure;
            }
            if (failure instanceof AcpExecutionError && failure.code === "authentication_required") {
                throw new AgentProbeError("authentication_required", "Agent authentication is required", {
                    cause: failure,
                });
            }
            throw new AgentProbeError("acp_incompatible", "Pi initialization failed", { cause: failure });
        }
    };
    // The Pi ACP fork inlines embedded prompt resources into the turn message, so Morty
    // keeps the adapter's opt-in capability flag enabled for every launch it owns.
    override readonly createLaunchEnvironment = async (
        context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => {
        // Pi encodes the workspace path itself into a native session directory name. Long nested
        // workspaces therefore exceed filesystem name limits before Morty can run a readiness turn.
        // Keep persistence, but derive a bounded, stable directory from the resolved workspace.
        const workspaceHash = createHash("sha256").update(context.defaultWorkspace).digest("hex").slice(0, 24);
        const sessionDirectory = join(context.dataDirectory, "agents", "pi", "sessions", workspaceHash);
        return Object.freeze({
            PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true",
            MORTY_PI_SESSION_DIR: sessionDirectory,
        });
    };
    readonly harness = "pi";
    readonly label = "Pi";
    override readonly minimumSupportedAgentVersion = "0.85.0";
    override readonly authenticationCommand = (): string => "pi";
    constructor() {
        super("MORTY_PI_PATH");
    }
}
