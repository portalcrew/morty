import {
    type CompleteElicitationNotification,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    methods,
    PROTOCOL_VERSION,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import type { SessionCapabilities } from "@portalcrew/morty-client/protocol";
import { AcpExecutionError } from "../../../src/engine/acp/acp-error.ts";
import type { AcpAgentDefinition } from "../../../src/engine/acp/agent/agent-definition.ts";
import { normalizeAcpCapabilities } from "../../../src/engine/acp/protocol/session-capabilities.ts";
import { AgentProbeError } from "../../../src/engine/agent/discovery/agent-probe-error.ts";
import {
    type AgentReadinessProbeParams,
    filterEnvironment,
} from "../../../src/engine/agent/discovery/agent-readiness.ts";
import { LocalAgentSpecification } from "../../../src/engine/agent/specification/agent-specification.ts";
import type { AcpClientHandler } from "../acp/create-client.ts";
import type { AgentConnectionFactory } from "./agent-connection.ts";
import { connectControlledAgent, registerControlledConnection } from "./controlled-agent-definition.ts";

class DiscoveryAcpHandler implements AcpClientHandler {
    readonly onElicitation = (
        _request: CreateElicitationRequest,
        _signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => Promise.reject(new Error("ACP probe does not accept elicitations"));

    readonly onElicitationComplete = (_notification: CompleteElicitationNotification): Promise<void> =>
        Promise.resolve();

    readonly onPermission = (
        _request: RequestPermissionRequest,
        _signal: AbortSignal,
    ): Promise<RequestPermissionResponse> => Promise.reject(new Error("ACP probe does not grant permissions"));

    readonly onUpdate = (_notification: SessionNotification): Promise<void> => Promise.resolve();
}

/** Exercises the same adapter-owned connection used by sessions, with a bounded probe lifetime. */
async function probeAcpReadiness(
    specification: {
        readonly acpProbeTimeoutMilliseconds: number;
        readonly authenticationCommand: () => string;
    },
    agent: AcpAgentDefinition,
    environment: Readonly<NodeJS.ProcessEnv>,
    defaultWorkspace: string,
    signal: AbortSignal,
): Promise<SessionCapabilities> {
    signal.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("ACP probe timed out"));
    }, specification.acpProbeTimeoutMilliseconds);
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
        abort();
    }
    try {
        const runtime = connectControlledAgent(
            agent.withEnvironment({ ...filterEnvironment(environment), ...agent.environment }),
            { cwd: defaultWorkspace, client: new DiscoveryAcpHandler() },
        );
        try {
            return await runtime.race(
                (async () => {
                    await runtime.initialize(controller.signal);
                    const initialized = await runtime.connection.agent.request(
                        methods.agent.initialize,
                        {
                            clientCapabilities: {},
                            clientInfo: { name: "morty", version: "0.0.3" },
                            protocolVersion: PROTOCOL_VERSION,
                        },
                        { cancellationSignal: controller.signal },
                    );
                    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
                        throw new AgentProbeError(
                            "acp_incompatible",
                            "ACP agent selected an unsupported protocol version",
                        );
                    }
                    return normalizeAcpCapabilities(initialized);
                })(),
                "The ACP endpoint stopped during initialization",
                controller.signal,
            );
        } finally {
            await runtime.closeProcess();
        }
    } catch (error) {
        signal.throwIfAborted();
        if (timedOut) {
            throw new AgentProbeError("adapter_probe_timeout", "ACP agent probe timed out", { cause: error });
        }
        if (error instanceof AgentProbeError) {
            throw error;
        }
        if (
            error instanceof AcpExecutionError &&
            error.code === "authentication_required" &&
            specification.authenticationCommand().length > 0
        ) {
            throw new AgentProbeError("authentication_required", "Agent authentication is required", { cause: error });
        }
        throw new AgentProbeError("acp_incompatible", "ACP agent initialization failed", { cause: error });
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
    }
}

export abstract class ControlledReadinessSpecification extends LocalAgentSpecification {
    abstract readonly createConnection: AgentConnectionFactory;

    readonly probeReadiness = (params: AgentReadinessProbeParams): Promise<SessionCapabilities> => {
        registerControlledConnection(params.agent, this.createConnection);
        return probeAcpReadiness(this, params.agent, params.environment, params.defaultWorkspace, params.signal);
    };
}
