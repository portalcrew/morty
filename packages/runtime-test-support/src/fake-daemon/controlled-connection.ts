import type { AgentApp, ClientConnection } from "@agentclientprotocol/sdk/unstable";
import type { AgentTermination } from "../../../cli/src/engine/acp/agent/agent-lifecycle.ts";
import { raceAgentOperation } from "../../../cli/src/engine/acp/connection/agent-operation.ts";
import { type AcpClientHandler, createAcpClient } from "../../../cli/tests/support/acp/create-client.ts";
import type { AgentConnection } from "../../../cli/tests/support/agents/agent-connection.ts";

export interface ControlledAcpPeer {
    readonly terminated: Promise<AgentTermination>;
    readonly app: () => AgentApp;
    readonly initialize: (signal: AbortSignal) => Promise<void>;
    readonly close: () => Promise<void>;
}

export class ControlledEndpointConnection implements AgentConnection {
    readonly #peer: ControlledAcpPeer;
    readonly connection: ClientConnection;
    readonly termination;
    #closePromise: Promise<void> | null = null;

    constructor(peer: ControlledAcpPeer, client: AcpClientHandler) {
        this.#peer = peer;
        this.termination = peer.terminated;
        this.connection = createAcpClient(client).connect(peer.app());
    }

    readonly initialize = async (signal: AbortSignal): Promise<void> => await this.#peer.initialize(signal);
    readonly closeProcess = (): Promise<void> => {
        this.#closePromise ??= (async () => {
            try {
                await this.#peer.close();
            } finally {
                this.connection.close();
            }
        })();
        return this.#closePromise;
    };
    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        raceAgentOperation(operation, this.termination, exitMessage, signal);
}
