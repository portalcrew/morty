import {
    type AgentApp,
    type AgentConnection,
    agent as createAgentApp,
    methods,
    PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk/unstable";
import { type ControlledAcpPeer, ControlledEndpointConnection } from "@morty-build/runtime-test-support/fake-daemon";
import type { AgentTermination } from "../../../src/engine/acp/agent/agent-lifecycle.ts";
import type { AgentConnectionFactory } from "./agent-connection.ts";

export interface AgentOperation {
    readonly endpoint: number;
    readonly method: string;
    readonly sessionId: string;
}

/** Keeps the requests that reach it in flight until a scenario releases them. */
class RequestGate {
    #held: Promise<void> = Promise.resolve();
    #entered = Promise.withResolvers<void>();
    #release: () => void = () => undefined;

    /** Blocks the requests that arrive from now on; `entered` settles once one of them is waiting. */
    readonly hold = (): { readonly entered: Promise<void>; readonly release: () => void } => {
        const held = Promise.withResolvers<void>();
        this.#entered = Promise.withResolvers<void>();
        this.#held = held.promise;
        this.#release = held.resolve;
        return { entered: this.#entered.promise, release: held.resolve };
    };

    readonly release = (): void => this.#release();

    readonly pass = async (): Promise<void> => {
        this.#entered.resolve();
        await this.#held;
    };
}

/** One Agent process; records the Session requests it serves. */
export class ControlledSessionEndpoint implements ControlledAcpPeer {
    readonly #agent: ControlledSessionAgent;
    readonly #app: AgentApp;
    #connection: AgentConnection | null = null;
    readonly #termination = Promise.withResolvers<AgentTermination>();
    readonly terminated = this.#termination.promise;

    constructor(endpoint: number, agent: ControlledSessionAgent) {
        this.#agent = agent;
        const record = (method: string, sessionId: string): void => {
            agent.operations.push({ endpoint, method, sessionId });
        };
        this.#app = createAgentApp({ name: "controlled-session-agent" })
            .onConnect((connection) => {
                this.#connection = connection;
            })
            .onRequest(methods.agent.initialize, () => ({
                agentCapabilities: {
                    loadSession: false,
                    promptCapabilities: { embeddedContext: false, image: false },
                    sessionCapabilities: { close: {}, resume: {} },
                },
                agentInfo: { name: "Controlled Session Agent", version: "1.0.0" },
                authMethods: [],
                protocolVersion: PROTOCOL_VERSION,
            }))
            .onRequest(methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                record(methods.agent.session.new, sessionId);
                return { sessionId };
            })
            .onRequest(methods.agent.session.resume, (context) => {
                record(methods.agent.session.resume, context.params.sessionId);
                return {};
            })
            .onRequest(methods.agent.session.prompt, (context) => {
                record(methods.agent.session.prompt, context.params.sessionId);
                return { stopReason: "end_turn" as const };
            })
            .onRequest(methods.agent.session.close, (context) => {
                record(methods.agent.session.close, context.params.sessionId);
                return {};
            });
    }

    readonly app = (): AgentApp => this.#app;
    readonly initialize = async (signal: AbortSignal): Promise<void> => signal.throwIfAborted();
    readonly close = async (): Promise<void> => {
        await this.#agent.closes.pass();
        this.#connection?.close();
        this.#termination.resolve({ kind: "closed" });
    };
}

/**
 * A controlled in-process Agent. Every Agent process the Computer starts for it takes the next
 * endpoint index, so a scenario can tell which process served each request.
 */
export class ControlledSessionAgent {
    readonly createConnection: AgentConnectionFactory = (options) =>
        new ControlledEndpointConnection(this.createEndpoint(), options.client);
    readonly operations: AgentOperation[] = [];
    /** Holds the end of process teardown, so a close stays in flight. */
    readonly closes = new RequestGate();
    readonly #endpoints: ControlledSessionEndpoint[] = [];

    readonly createEndpoint = (): ControlledAcpPeer => {
        const endpoint = new ControlledSessionEndpoint(this.#endpoints.length, this);
        this.#endpoints.push(endpoint);
        return endpoint;
    };

    readonly endpointCount = (): number => this.#endpoints.length;

    readonly releaseAll = (): void => {
        this.closes.release();
    };
}
