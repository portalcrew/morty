import { AgentQuestions } from "../../components/chat/agent-questions.tsx";
import { AgentThinking } from "../../components/chat/agent-thinking.tsx";
import { chatSessionMessageItemClassName } from "../../components/chat/chat-session-layout.ts";
import { isFileEditToolCall } from "../../components/chat/tools/tool-renderer-registry.tsx";
import { cn } from "../../lib/utils.ts";
import { agentReplyCopyText, agentReplyMessageGroups } from "../../view-models/chat/agent-reply-copy.ts";
import { type SessionMessage, sessionExecutionStates } from "../../view-models/chat/session-presentation.ts";
import {
    agentReplySections,
    hasRunningProcessWork,
    type SessionRenderItem,
    sessionRenderGroups,
    sessionRenderItems,
} from "../../view-models/chat/session-render-items.ts";
import type { UserMessageCollapseStore } from "../../view-models/chat/user-message-collapse-store.ts";
import { MortyAssistantText, MortySessionMessage } from "./morty-session-message.tsx";
import { SessionReplyContent } from "./session-reply-content.tsx";

function PreviewRenderItem({
    collapseStore,
    item,
}: {
    readonly collapseStore: UserMessageCollapseStore;
    readonly item: SessionRenderItem;
}) {
    if (item.kind === "assistant-text" && item.messageId !== null && item.questions.length > 0) {
        return (
            <AgentQuestions
                answerable={false}
                choices={{}}
                disabled
                onAnswer={() => undefined}
                onChoose={() => undefined}
                questions={item.questions}
                ready={false}
            />
        );
    }
    if (item.kind === "assistant-text") {
        return <MortyAssistantText openLocalFile={() => undefined} streaming={false} text={item.text} />;
    }
    if (item.kind === "thinking") {
        return <AgentThinking active={false} entries={item.entries} />;
    }
    return (
        <MortySessionMessage
            collapseStore={collapseStore}
            deliveryUnknownUserMessageId={null}
            message={item.message}
            onRemoveUnknownDelivery={() => undefined}
            onRetryUnknownDelivery={() => undefined}
            openLocalFile={() => undefined}
            retryUnknownDeliveryDisabled
        />
    );
}

export function NativeSessionPreviewMessages({
    collapseStore,
    messages,
}: {
    readonly collapseStore: UserMessageCollapseStore;
    readonly messages: readonly SessionMessage[];
}) {
    const groups = sessionRenderGroups(sessionRenderItems(messages));
    // Native previews have Agent events but no Morty execution context; use their unmanaged turn boundaries.
    const executionStates = sessionExecutionStates(
        messages.map((message) => ({ ...message, executionContext: { kind: "unmanaged" as const } })),
        false,
    );
    const executionByItemId = new Map(
        messages.flatMap((message, index) => {
            const state = executionStates[index];
            return state === undefined ? [] : [[message.firstEvent.eventId, state] as const];
        }),
    );
    const replyMessages = new Map(
        agentReplyMessageGroups(messages).map((group) => [group.id, group.messages] as const),
    );
    return groups.map((group, index) => {
        if (group.kind === "user") {
            return (
                <div
                    className={cn(
                        chatSessionMessageItemClassName,
                        index > 0 && groups[index - 1]?.kind === "user" && "mt-1",
                    )}
                    key={group.id}
                >
                    <PreviewRenderItem collapseStore={collapseStore} item={group.item} />
                </div>
            );
        }
        const copyText = agentReplyCopyText(
            replyMessages.get(group.id) ?? [],
            executionByItemId.get(group.id) ?? { kind: "open" },
            hasRunningProcessWork(group.items),
        );
        return (
            <SessionReplyContent
                copyText={copyText}
                key={group.id}
                renderItem={(item) => <PreviewRenderItem collapseStore={collapseStore} item={item} />}
                sections={agentReplySections(group.items, isFileEditToolCall)}
            />
        );
    });
}
