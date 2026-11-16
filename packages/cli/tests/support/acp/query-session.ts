import { methods } from "@agentclientprotocol/sdk/unstable";
import type { SessionCapabilities } from "@portalcrew/morty-client/protocol";
import { AcpExecutionError } from "../../../src/engine/acp/acp-error.ts";
import {
    RetryableAcpInitializationError,
    validateAgentRuntime,
} from "../../../src/engine/acp/adapter/agent-initialization.ts";
import type { NativeSessionQuery } from "../../../src/engine/acp/native-history/preview-contract.ts";
import { type NativeSessionPage, nativeSessionPageSchema } from "../../../src/engine/acp/protocol/native-session.ts";
import type { AcpSessionConnector, AdapterSessionConnection } from "./session-events.ts";

export class AcpQuerySession {
    readonly #connection: AdapterSessionConnection;
    #lifecycle: { readonly kind: "open" } | { readonly kind: "terminated" } = { kind: "open" };

    private constructor(options: NativeSessionQuery, connector: AcpSessionConnector) {
        this.#connection = connector.connectQuerySession({
            agent: options.agent,
            cwd: options.cwd,
            ...(options.externalizeUpdate === undefined ? {} : { externalizeUpdate: options.externalizeUpdate }),
            onEvent: async () => {},
        });
        void this.#connection.termination.then(() => {
            this.#lifecycle = { kind: "terminated" };
        });
    }

    static readonly start = async (
        options: NativeSessionQuery,
        connector: AcpSessionConnector,
    ): Promise<AcpQuerySession> => {
        const { agent, signal } = options;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await validateAgentRuntime(agent, signal);
            const runtime = new AcpQuerySession(options, connector);
            try {
                await runtime.#connection.initializeAgent(options.signal);
                return runtime;
            } catch (error) {
                await runtime.closeProcess();
                signal.throwIfAborted();
                if (error instanceof RetryableAcpInitializationError && attempt === 1) {
                    console.warn(`[${agent.harness}-acp] ACP agent initialization failed; retrying once`);
                    continue;
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent initialization failed", { cause: error });
            }
        }
        throw new AcpExecutionError("ACP agent initialization failed");
    };

    readonly capabilities = (): SessionCapabilities => this.#connection.snapshot().capabilities;
    readonly hasTerminated = (): boolean => {
        switch (this.#lifecycle.kind) {
            case "open":
                return false;
            case "terminated":
                return true;
            default: {
                const unreachable: never = this.#lifecycle;
                return unreachable;
            }
        }
    };
    readonly listNativeSessions = async (cursor: string | null, signal: AbortSignal): Promise<NativeSessionPage> => {
        if (!this.capabilities().listSessions) {
            throw new AcpExecutionError(
                "This Agent does not support native session listing",
                {},
                "native_session_unsupported",
            );
        }
        const response: unknown = await this.#connection.race(
            this.#connection.connection.agent.request(methods.agent.session.list, cursor === null ? {} : { cursor }, {
                cancellationSignal: signal,
            }),
            "ACP agent exited while listing sessions",
            signal,
        );
        const decoded = nativeSessionPageSchema.safeParse(response);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "The Agent returned an invalid native session list",
                { cause: decoded.error },
                "invalid_native_session_response",
            );
        }
        return decoded.data;
    };

    readonly closeProcess = async (): Promise<void> => await this.#connection.closeProcess();
}
