import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { AcpExecutionError } from "../acp-error.ts";
import { waitForAgentOperation } from "../connection/agent-operation.ts";
import { AgentUpdateStream } from "../connection/agent-update-stream.ts";
import type { AcpContentExternalizer, ExternalizeSessionUpdate } from "../content/content-externalizer.ts";
import type { NativeSessionQuery } from "../native-history/preview-contract.ts";
import { sessionIdSchema } from "../protocol/native-session.ts";
import type { HarnessLifetime } from "./harness-session.ts";
import {
    type NativeSessionEvent,
    type NativeSessionInteractions,
    type NativeSessionSubscriber,
    nativeSessionEvent,
} from "./native-session-event.ts";

export interface HarnessCallbackParams {
    readonly externalizeUpdate?: ExternalizeSessionUpdate;
    readonly onSessionEvent: (sessionId: string, event: NativeSessionEvent) => Promise<void>;
    readonly interactions: Pick<NativeSessionInteractions, "onPermission" | "onElicitation"> & {
        readonly onElicitationComplete?: NativeSessionInteractions["onElicitationComplete"];
    };
}

export function harnessSessionCallbacks(
    subscriber: NativeSessionSubscriber,
    externalizeUpdate: ExternalizeSessionUpdate | undefined,
): HarnessCallbackParams {
    return { ...subscriber, ...(externalizeUpdate === undefined ? {} : { externalizeUpdate }) };
}

export function harnessPreviewCallbacks(
    query: NativeSessionQuery,
    onSessionEvent: HarnessCallbackParams["onSessionEvent"],
): HarnessCallbackParams {
    const rejectInteraction = async (): Promise<never> => {
        throw new AcpExecutionError(
            "Read-only history previews cannot request user interaction",
            {},
            "native_session_interaction_unsupported",
        );
    };
    return {
        onSessionEvent,
        interactions: {
            onPermission: rejectInteraction,
            onElicitation: rejectInteraction,
            onElicitationComplete: rejectInteraction,
        },
        ...(query.externalizeUpdate === undefined ? {} : { externalizeUpdate: query.externalizeUpdate }),
    };
}

/** Shared ordered delivery and interaction lifetime; provider callbacks retain their own message identity. */
export class HarnessClientEvents {
    readonly #updates: AgentUpdateStream;
    readonly params: HarnessCallbackParams;
    readonly lifetime: HarnessLifetime;
    constructor(
        harness: string,
        params: HarnessCallbackParams,
        externalizer: Pick<AcpContentExternalizer, "update">,
        lifetime: HarnessLifetime,
    ) {
        this.params = params;
        this.lifetime = lifetime;
        this.#updates = new AgentUpdateStream(async (notification) => {
            const sessionId = sessionIdSchema.parse(notification.sessionId);
            const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
            signal.throwIfAborted();
            const externalized =
                params.externalizeUpdate === undefined
                    ? await externalizer.update({ harness, sessionId }, notification.update, signal)
                    : await params.externalizeUpdate(sessionId, notification.update, signal);
            for (const event of externalized.events) {
                signal.throwIfAborted();
                await waitForAgentOperation(
                    params.onSessionEvent(sessionId, nativeSessionEvent(externalized.agent, event)),
                    signal,
                );
            }
        });
    }

    readonly receive = async (notification: SessionNotification): Promise<void> => {
        if (this.lifetime.signal.aborted) {
            return;
        }
        try {
            const update = notification.update;
            switch (update.sessionUpdate) {
                case "user_message_chunk":
                case "agent_message_chunk":
                case "agent_thought_chunk":
                    if (typeof update.messageId !== "string" || update.messageId.length === 0) {
                        throw new AcpExecutionError(
                            "The harness omitted its message identity",
                            {},
                            "invalid_native_session_response",
                        );
                    }
                    await this.#updates.receive({
                        ...notification,
                        update: { ...update, messageId: update.messageId },
                    });
                    break;
                default:
                    await this.#updates.receive({ ...notification, update });
            }
        } catch (cause) {
            this.lifetime.fail(cause);
            throw cause;
        }
    };
    readonly drained = (): Promise<void> => this.#updates.drained();
    readonly permission: NativeSessionInteractions["onPermission"] = async (request, signal) => {
        const stopped = AbortSignal.any([signal, this.lifetime.signal]);
        await waitForAgentOperation(this.drained(), stopped);
        return await waitForAgentOperation(this.params.interactions.onPermission(request, stopped), stopped);
    };
    readonly elicitation: NativeSessionInteractions["onElicitation"] = async (request, signal) => {
        const stopped = AbortSignal.any([signal, this.lifetime.signal]);
        await waitForAgentOperation(this.drained(), stopped);
        return await waitForAgentOperation(this.params.interactions.onElicitation(request, stopped), stopped);
    };
}
