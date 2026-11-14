import type { ClientConnection } from "@agentclientprotocol/sdk/unstable";
import type { AgentTermination, PromptDelegationStage } from "../../../src/engine/acp/agent/agent-lifecycle.ts";
import type { AcpClientHandler } from "../acp/create-client.ts";

/** Adapter-owned runtime and transport for one ACP client. */
export interface AgentConnection {
    readonly connection: ClientConnection;
    readonly termination: Promise<AgentTermination>;
    readonly initialize: (signal: AbortSignal) => Promise<void>;
    readonly closeProcess: () => Promise<void>;
    readonly race: <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal) => Promise<T>;
}

export interface AgentConnectionOptions {
    readonly cwd: string;
    readonly client: AcpClientHandler;
    readonly onPromptDelegation?: (stage: PromptDelegationStage) => Promise<void>;
}

export type AgentConnectionFactory = (
    options: AgentConnectionOptions & {
        readonly command: string;
        readonly environment: Readonly<Record<string, string>>;
    },
) => AgentConnection;
