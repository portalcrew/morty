import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import type WebSocket from "ws";
import type { NativeSessionInteractions, NativeSessionSubscriber } from "../../adapter/native-session-event.ts";
import type { BackgroundActivity, PromptDelegationStage } from "../../agent/agent-lifecycle.ts";

type MessageUpdate = Extract<
    SessionUpdate,
    { readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" }
>;
export type CodexMessageUpdate = MessageUpdate & {
    readonly messageId: string;
};
export type CodexSessionUpdate = CodexMessageUpdate | Exclude<SessionUpdate, MessageUpdate>;
interface CodexSessionNotification extends Omit<SessionNotification, "update"> {
    readonly update: CodexSessionUpdate;
}
export interface CodexClientOptions {
    readonly onObservedTurn?: NativeSessionSubscriber["onObservedTurn"];
    readonly command: string;
    readonly socket?: WebSocket;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly onBackgroundActivity?: (activity: BackgroundActivity) => void;
    readonly onPromptDelegation?: (stage: PromptDelegationStage) => Promise<void>;
    readonly onSessionUpdate: (notification: CodexSessionNotification) => Promise<void>;
    readonly interactions: Pick<NativeSessionInteractions, "onPermission" | "onElicitation">;
}

import { type PromptResponse, RequestError } from "@agentclientprotocol/sdk/unstable";
import { OperationError } from "../../../infra/operation-error.ts";

export async function promptResultWithMessageId(
    result: Promise<PromptResponse>,
    messageId: string,
): Promise<PromptResponse> {
    try {
        const response = await result;
        return { ...response, _meta: { ...response._meta, messageId } };
    } catch (cause) {
        if (cause instanceof RequestError) {
            const data = typeof cause.data === "object" && cause.data !== null ? cause.data : {};
            cause.data = { ...data, messageId };
            throw cause;
        }
        // An OperationError carries a message written for clients (for example Codex's own turn failure
        // reason or why the app-server stopped); any other error may quote internals and stays opaque.
        const detail = cause instanceof OperationError ? cause.message : "The prompt could not be completed";
        // ACP's internalError helper would prefix "Internal error: " and present Codex's reason as Morty's own fault.
        const failure = new RequestError(-32_603, detail, { messageId });
        Object.defineProperty(failure, "cause", { value: cause });
        throw failure;
    }
}
