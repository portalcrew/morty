import { type SessionExecutionState, type SessionMessage, sessionTextValue } from "./session-presentation.ts";

export interface AgentReplyMessageGroup {
    readonly id: string;
    readonly messages: readonly SessionMessage[];
}

export function agentReplyMessageGroups(messages: readonly SessionMessage[]): readonly AgentReplyMessageGroup[] {
    const groups: AgentReplyMessageGroup[] = [];
    let replyMessages: SessionMessage[] = [];
    const flush = (): void => {
        const first = replyMessages[0];
        if (first !== undefined) {
            groups.push({ id: first.firstEvent.eventId, messages: replyMessages });
        }
        replyMessages = [];
    };
    for (const message of messages) {
        if (message.role === "user") {
            flush();
        } else {
            replyMessages.push(message);
        }
    }
    flush();
    return groups;
}

export function agentReplyCopyText(
    messages: readonly SessionMessage[],
    execution: SessionExecutionState,
    generating: boolean,
): string | null {
    if (generating || execution.kind === "open") {
        return null;
    }
    const parts: string[] = [];
    for (const message of messages) {
        if (message.role !== "assistant") {
            continue;
        }
        const presentation = message.presentation;
        if (presentation.kind === "message" && presentation.content.type === "text") {
            const text = sessionTextValue(presentation.content.text);
            if (text.length > 0) {
                parts.push(text);
            }
        }
    }
    const text = parts.join("\n\n");
    return text.trim().length === 0 ? null : text;
}
