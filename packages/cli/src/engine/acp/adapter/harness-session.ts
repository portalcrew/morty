import type { PromptRequest, PromptResponse } from "@agentclientprotocol/sdk/unstable";
import { AcpExecutionError } from "../acp-error.ts";
import { agentOperationError, waitForAgentOperation } from "../connection/agent-operation.ts";
import { type SessionId, sessionIdSchema } from "../protocol/native-session.ts";

export interface HarnessClient {
    readonly signal: AbortSignal;
    readonly prompt: (request: PromptRequest) => Promise<PromptResponse>;
    readonly cancel: (request: { readonly sessionId: string }) => Promise<void>;
    readonly dispose: (mode: "graceful" | "force") => Promise<void>;
}

export interface HarnessLifetime {
    readonly signal: AbortSignal;
    readonly fail: (cause: unknown) => void;
}

export async function disposeHarnessClient(
    agent: HarnessClient,
    sessionId: SessionId,
    drained: () => Promise<void>,
    mode: "graceful" | "force",
): Promise<void> {
    if (mode !== "force" && !agent.signal.aborted) {
        // Give the provider a bounded opportunity to persist interrupted work before retiring it.
        try {
            await waitForAgentOperation(agent.cancel({ sessionId }), AbortSignal.timeout(1_000));
        } catch {
            // Retirement must still release resources when cancellation fails or stalls.
        }
    }
    await agent.dispose("force");
    if (mode !== "force") {
        await drained();
    }
}

export class HarnessSession<Client extends HarnessClient> {
    readonly sessionId: SessionId;
    readonly workspace: { readonly cwd: string };
    readonly agent: Client;
    readonly #lifetime: AbortController;
    readonly #drained: () => Promise<void>;
    #closing: Promise<void> | null = null;

    private constructor(
        sessionId: SessionId,
        workspace: { readonly cwd: string },
        agent: Client,
        lifetime: AbortController,
        drained: () => Promise<void>,
    ) {
        this.sessionId = sessionId;
        this.workspace = workspace;
        this.agent = agent;
        this.#lifetime = lifetime;
        this.#drained = drained;
    }

    static readonly start = async <Client extends HarnessClient, Response extends { readonly sessionId: string }>(
        params: {
            readonly workspace: { readonly cwd: string };
            readonly signal: AbortSignal;
            readonly create: (
                lifetime: HarnessLifetime,
            ) => Promise<{ readonly agent: Client; readonly drained: () => Promise<void> }>;
        },
        open: (agent: Client, signal: AbortSignal) => Promise<Response>,
    ): Promise<{ readonly session: HarnessSession<Client>; readonly response: Response }> => {
        params.signal.throwIfAborted();
        const lifetime = new AbortController();
        const { agent, drained } = await params.create({
            signal: lifetime.signal,
            fail: (cause) => lifetime.abort(cause),
        });
        try {
            const signal = AbortSignal.any([params.signal, lifetime.signal]);
            signal.throwIfAborted();
            const response = await waitForAgentOperation(open(agent, signal), signal);
            await waitForAgentOperation(drained(), signal);
            return {
                session: new HarnessSession(
                    sessionIdSchema.parse(response.sessionId),
                    params.workspace,
                    agent,
                    lifetime,
                    drained,
                ),
                response,
            };
        } catch (cause) {
            lifetime.abort(cause);
            await agent.dispose("force");
            params.signal.throwIfAborted();
            throw agentOperationError(cause);
        }
    };

    get available(): boolean {
        return !this.#lifetime.signal.aborted && !this.agent.signal.aborted;
    }

    readonly drained = (signal: AbortSignal): Promise<void> =>
        waitForAgentOperation(this.#drained(), AbortSignal.any([signal, this.#lifetime.signal]));

    readonly assertWorkspace = (workspace: { readonly cwd: string }): void => {
        if (this.workspace.cwd !== workspace.cwd) {
            throw new AcpExecutionError("The session workspace cannot change", {}, "session_identity_mismatch");
        }
    };

    /** Success includes delivery of every turn event; cancellation and delivery failure stop the turn. */
    readonly prompt = async (
        request: Omit<PromptRequest, "sessionId">,
        signal: AbortSignal,
    ): Promise<PromptResponse> => {
        signal.throwIfAborted();
        this.#lifetime.signal.throwIfAborted();
        const stopped = AbortSignal.any([signal, this.#lifetime.signal]);
        const stopTurn = (): void => {
            if (!this.agent.signal.aborted) {
                void this.cancel(new AbortController().signal).catch(() => undefined);
            }
        };
        stopped.addEventListener("abort", stopTurn, { once: true });
        try {
            const response = await waitForAgentOperation(
                this.agent.prompt({ ...request, sessionId: this.sessionId }),
                stopped,
            );
            await waitForAgentOperation(this.#drained(), stopped);
            return response;
        } catch (cause) {
            signal.throwIfAborted();
            this.#lifetime.signal.throwIfAborted();
            await waitForAgentOperation(this.#drained(), stopped);
            throw cause;
        } finally {
            stopped.removeEventListener("abort", stopTurn);
        }
    };

    readonly cancel = async (signal: AbortSignal): Promise<"retained" | "closed"> => {
        signal.throwIfAborted();
        const deadline = AbortSignal.timeout(30_000);
        try {
            await waitForAgentOperation(
                this.agent.cancel({ sessionId: this.sessionId }),
                AbortSignal.any([signal, deadline]),
            );
            return "retained";
        } catch (cause) {
            signal.throwIfAborted();
            if (!deadline.aborted) {
                throw cause;
            }
            await this.dispose("force");
            return "closed";
        }
    };

    readonly dispose = (mode: "graceful" | "force"): Promise<void> => {
        if (this.#closing === null) {
            this.#closing = this.#dispose(mode);
        }
        return this.#closing;
    };

    readonly #dispose = async (mode: "graceful" | "force"): Promise<void> => {
        try {
            await disposeHarnessClient(this.agent, this.sessionId, this.#drained, mode);
        } finally {
            this.#lifetime.abort(new DOMException("The harness session was released", "AbortError"));
        }
    };
}
