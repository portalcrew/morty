// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { type PromptResponse, RequestError } from "@agentclientprotocol/sdk/unstable";

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
        const failure = RequestError.internalError({ messageId }, "The prompt could not be completed");
        Object.defineProperty(failure, "cause", { value: cause });
        throw failure;
    }
}

type MessageUpdate = Extract<
    SessionUpdate,
    { readonly sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" }
>;
export type ClaudeMessageUpdate = MessageUpdate & {
    readonly messageId: string;
};
export type ClaudeSessionUpdate = ClaudeMessageUpdate | Exclude<SessionUpdate, MessageUpdate>;
export interface ClaudeSessionNotification extends Omit<SessionNotification, "update"> {
    readonly update: ClaudeSessionUpdate;
}
