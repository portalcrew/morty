import { isAbsolute, resolve } from "node:path";
import { methods, RequestError } from "@agentclientprotocol/sdk/unstable";
import { decodeAgentPromptResponse, type SessionConfigOption } from "@portalcrew/morty-client/protocol";
import { z } from "zod";
import { AcpConfigurationValueUnavailableError, AcpExecutionError } from "../../../src/engine/acp/acp-error.ts";
import { buildPromptContent } from "../../../src/engine/acp/client/prompt-content.ts";
import type { AcpContentExternalizer } from "../../../src/engine/acp/content/content-externalizer.ts";
import type {
    Adapter,
    AdapterPromptResult,
    AdapterSessionCreateParams,
    AdapterSessionScope,
    AdapterSessionTarget,
} from "../../../src/engine/acp/native-history/preview-contract.ts";
import { sessionIdSchema } from "../../../src/engine/acp/protocol/native-session.ts";
import { isRecord, truncate } from "../../../src/engine/util/value-utils.ts";
import { configureControlledSession, SessionConfigProtocolError } from "./configure-controlled-session.ts";
import { AdapterSessionConnection } from "./session-events.ts";

export interface AcpExecutionConnection {
    readonly connection: AdapterSessionConnection;
    readonly scope: AdapterSessionScope;
    readonly subscriber: AdapterSessionCreateParams;
}

const absolutePathSchema = z.string().min(1).refine(isAbsolute);
const nativeHistoryRevisionSchema = z.object({ latestEntryId: z.string().max(256) });
const isMethodNotFound = (cause: unknown): boolean => cause instanceof RequestError && cause.code === -32_601;
const targetSchema = z.object({
    sessionId: sessionIdSchema,
    cwd: absolutePathSchema,
});

/** Adapter-private active writers. Query sessions never enter this registry. */
export class AcpExecutionConnections {
    readonly #sessions = new Set<AcpExecutionConnection>();
    readonly #externalizer: Pick<AcpContentExternalizer, "update">;

    constructor(externalizer: Pick<AcpContentExternalizer, "update">) {
        this.#externalizer = externalizer;
    }

    readonly acquire = (params: AdapterSessionCreateParams): AcpExecutionConnection => {
        params.signal.throwIfAborted();
        const existing = [...this.#sessions].find(
            ({ subscriber }) => subscriber.onSessionEvent === params.onSessionEvent,
        );
        // A subscriber is one Agent session, whose Agent and workspace never change.
        if (existing !== undefined) {
            return existing;
        }
        const connection = new AdapterSessionConnection(
            {
                agent: params.scope.agent,
                cwd: params.scope.cwd,
                ...(params.scope.externalizeUpdate === undefined
                    ? {}
                    : { externalizeUpdate: params.scope.externalizeUpdate }),
                onEvent: (event) => params.onSessionEvent(connection.events.sessionId(), event),
                onPromptSuggestions: async (suggestions) =>
                    await params.onPromptSuggestions?.(connection.events.sessionId(), suggestions),
                ...(params.onBackgroundActivity === undefined
                    ? {}
                    : { onBackgroundActivity: params.onBackgroundActivity }),
                ...(params.onPromptDelegation === undefined ? {} : { onPromptDelegation: params.onPromptDelegation }),
                interactions: params.interactions,
            },
            this.#externalizer,
            () => this.#sessions.delete(session),
        );
        const session = { connection, scope: params.scope, subscriber: params };
        this.#sessions.add(session);
        return session;
    };

    readonly withConnection = async <T>(
        params: AdapterSessionCreateParams,
        operation: (session: AcpExecutionConnection, signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
        const signal = AbortSignal.any([params.signal, AbortSignal.timeout(60_000)]);
        signal.throwIfAborted();
        const session = this.acquire(params);
        const wasBound = session.connection.events.sessionId().length > 0;
        try {
            await session.connection.initializeAgent(signal);
            session.connection.beginStateChange();
            try {
                const result = await operation(session, signal);
                signal.throwIfAborted();
                return result;
            } catch (cause) {
                // Only this invocation's successfully acquired state change may be rolled back.
                session.connection.cancelStateChange();
                throw cause;
            }
        } catch (cause) {
            if (!wasBound) {
                await session.connection.closeProcess();
            }
            throw cause;
        }
    };

    readonly bind = (session: AcpExecutionConnection, sessionId: string): void => {
        const existing = this.#find({
            sessionId,
            cwd: session.scope.cwd,
        });
        if (existing !== undefined && existing !== session) {
            throw new AcpExecutionError("Another writer is using this native session", {}, "session_busy");
        }
        session.connection.events.select(sessionId);
    };

    readonly #find = (target: AdapterSessionTarget): AcpExecutionConnection | undefined => {
        const decoded = targetSchema.safeParse(target);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "The native session target is invalid",
                { cause: decoded.error },
                "invalid_agent_session",
            );
        }
        const matches = [...this.#sessions].filter(
            ({ connection, scope }) =>
                connection.events.sessionId() === decoded.data.sessionId &&
                scope.cwd === decoded.data.cwd &&
                scope.cwd === resolve(decoded.data.cwd),
        );
        if (matches.length > 1) {
            throw new AcpExecutionError("Another writer is using this native session", {}, "session_busy");
        }
        return matches[0];
    };

    readonly #resolve = (target: AdapterSessionTarget): AcpExecutionConnection => {
        const session = this.#find(target);
        if (session === undefined) {
            throw new AcpExecutionError("The native session is not active", {}, "invalid_agent_session");
        }
        return session;
    };

    readonly cancel: Adapter["cancel"] = async ({ signal, ...target }) => {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        bounded.throwIfAborted();
        const { connection } = this.#resolve(target);
        await connection.race(
            connection.connection.agent.notify(methods.agent.session.cancel, {
                sessionId: connection.events.sessionId(),
            }),
            "ACP agent exited while cancelling a prompt",
            bounded,
        );
        return "retained";
    };

    readonly closeSession: Adapter["closeSession"] = async ({ signal, ...target }) => {
        // Once teardown is requested, release the writer even if its caller is
        // cancelled. Only the graceful protocol request is interruptible.
        const session = this.#find(target);
        if (session === undefined) {
            signal.throwIfAborted();
            return;
        }
        const { connection } = session;
        try {
            signal.throwIfAborted();
            if (connection.snapshot().capabilities.closeSession) {
                try {
                    await connection.connection.agent.request(
                        methods.agent.session.close,
                        { sessionId: connection.events.sessionId() },
                        { cancellationSignal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]) },
                    );
                } catch {
                    // Process teardown remains authoritative when graceful close
                    // is rejected or its one-second deadline expires.
                    signal.throwIfAborted();
                }
            }
        } finally {
            await connection.closeProcess();
        }
        signal.throwIfAborted();
    };

    readonly releaseSession: Adapter["releaseSession"] = async ({ signal, ...target }) => {
        const session = this.#find(target);
        if (session !== undefined) {
            await session.connection.closeProcess();
        }
        signal.throwIfAborted();
    };

    readonly prompt: Adapter["prompt"] = async ({ content, signal, ...target }): Promise<AdapterPromptResult> => {
        signal.throwIfAborted();
        const { connection } = this.#resolve(target);
        const prompt = buildPromptContent(content, connection.snapshot().capabilities);
        const response: unknown = await connection
            .race(
                connection.connection.agent.request(
                    methods.agent.session.prompt,
                    { prompt, sessionId: target.sessionId },
                    { cancellationSignal: signal },
                ),
                "ACP agent exited during a prompt",
                signal,
            )
            .catch(async (cause: unknown) => {
                signal.throwIfAborted();
                await connection.events.drained();
                throw cause;
            });
        await connection.events.drained();
        try {
            const decoded = decodeAgentPromptResponse(response);
            return {
                stopReason: decoded.stopReason,
                ...(decoded.usage === undefined ? {} : { usage: decoded.usage }),
                ...(decoded._meta === undefined ? {} : { _meta: decoded._meta }),
            };
        } catch (cause) {
            throw new AcpExecutionError(
                "ACP agent returned an invalid prompt response",
                { cause },
                "acp_invalid_prompt_response",
            );
        }
    };

    readonly steer: Adapter["steer"] = async ({ content, signal, ...target }) => {
        signal.throwIfAborted();
        const { connection } = this.#resolve(target);
        if (!connection.snapshot().capabilities.steering) {
            throw new AcpExecutionError(
                "The selected agent does not support mid-turn steering",
                {},
                "steering_unsupported",
            );
        }
        const response: unknown = await connection.race(
            connection.connection.agent.request(
                "_session/steering",
                {
                    _meta: { steering: { idleBehavior: "promptRequired" } },
                    prompt: buildPromptContent(content, connection.snapshot().capabilities),
                    sessionId: target.sessionId,
                },
                { cancellationSignal: signal },
            ),
            "ACP agent exited during steering",
            signal,
        );
        if (isRecord(response)) {
            const outcome = response["outcome"];
            const messageId = response["messageId"];
            if (outcome === "injected") {
                return typeof messageId === "string" && messageId.length > 0 ? { outcome, messageId } : { outcome };
            }
            if (outcome === "promptRequired") {
                throw new AcpExecutionError(
                    "The target turn finished before steering could be injected",
                    {},
                    "steering_target_unavailable",
                );
            }
            if (outcome === "failed") {
                throw new AcpExecutionError("The Agent could not inject steering", {}, "steering_failed");
            }
        }
        throw new AcpExecutionError(
            "ACP agent returned an invalid steering response",
            {},
            "acp_invalid_steering_response",
        );
    };

    readonly renameSession: Adapter["renameSession"] = async ({ title, signal, ...target }) => {
        signal.throwIfAborted();
        const { connection } = this.#resolve(target);
        const normalized = truncate(title, 500);
        if (normalized.length === 0) {
            throw new AcpExecutionError("The Session title cannot be empty", {}, "invalid_session_title");
        }
        if (!connection.snapshot().capabilities.renameSession) {
            return;
        }
        try {
            await connection.race(
                connection.connection.agent.request(
                    "_session/rename",
                    { sessionId: target.sessionId, title: normalized },
                    { cancellationSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
                ),
                "ACP agent exited while renaming the Session",
                signal,
            );
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof AcpExecutionError) {
                throw error;
            }
            throw new AcpExecutionError(
                "The Agent could not rename the Session",
                { cause: error },
                "session_rename_failed",
            );
        }
    };

    readonly readNativeHistoryRevision: Adapter["readNativeHistoryRevision"] = async ({ signal, ...target }) => {
        signal.throwIfAborted();
        const { connection } = this.#resolve(target);
        let response: unknown;
        try {
            response = await connection.race(
                connection.connection.agent.request(
                    "_session/revision",
                    { sessionId: target.sessionId },
                    { cancellationSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) },
                ),
                "ACP agent exited while reading native history",
                signal,
            );
        } catch (error) {
            signal.throwIfAborted();
            // A harness without the extension keeps the behavior that predates revision tracking.
            if (error instanceof AcpExecutionError && isMethodNotFound(error.cause)) {
                return { kind: "untracked" };
            }
            throw error;
        }
        const decoded = nativeHistoryRevisionSchema.safeParse(response);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "ACP agent returned an invalid native history revision",
                { cause: decoded.error },
                "invalid_native_session_response",
            );
        }
        return { kind: "tracked", latestEntryId: decoded.data.latestEntryId };
    };

    readonly configureSession: Adapter["configureSession"] = async ({
        selection,
        signal,
        ...target
    }): Promise<readonly SessionConfigOption[]> => {
        signal.throwIfAborted();
        const { connection } = this.#resolve(target);
        const current = connection.snapshot().configOptions;
        const existing = current.find((option) => option.id === selection.configId);
        if (
            existing === undefined ||
            existing.type !== selection.type ||
            (existing.type === "select" && existing.values.length < 2)
        ) {
            throw new AcpExecutionError(
                "The requested ACP configuration option is unavailable",
                {},
                "invalid_session_configuration",
            );
        }
        if (
            existing.type === "select" &&
            selection.type === "select" &&
            !existing.values.some((entry) => entry.value === selection.value)
        ) {
            throw new AcpConfigurationValueUnavailableError(
                selection.configId,
                selection.value,
                existing.values.map((entry) => entry.value),
            );
        }
        connection.beginStateChange();
        try {
            const configured = await configureControlledSession(
                current,
                {
                    booleanValue: selection.type === "boolean" ? selection.booleanValue : false,
                    configId: selection.configId,
                    signal,
                    value: selection.type === "select" ? selection.value : "",
                },
                target.sessionId,
                {
                    request: async (method, params, failureMessage, signal) =>
                        await connection.race(
                            connection.connection.agent.request(method, params, { cancellationSignal: signal }),
                            failureMessage,
                            signal,
                        ),
                },
            );
            const applied = configured.find((option) => option.id === selection.configId);
            if (
                applied === undefined ||
                applied.type !== selection.type ||
                (applied.type === "boolean" &&
                    selection.type === "boolean" &&
                    applied.booleanValue !== selection.booleanValue) ||
                (applied.type === "select" && selection.type === "select" && applied.currentValue !== selection.value)
            ) {
                throw new AcpExecutionError(
                    "The Agent did not apply the requested session configuration",
                    {},
                    "invalid_session_configuration",
                );
            }
            await connection.events.drained();
            return connection.commitConfiguration(configured);
        } catch (error) {
            connection.cancelStateChange();
            if (error instanceof SessionConfigProtocolError) {
                throw new AcpExecutionError(error.message, { cause: error }, error.code);
            }
            throw error;
        }
    };

    readonly close = async (): Promise<void> => {
        const results = await Promise.allSettled(
            [...this.#sessions].map(({ connection }) => connection.closeProcess()),
        );
        for (const result of results) {
            if (result.status === "rejected") {
                throw result.reason;
            }
        }
    };
}
