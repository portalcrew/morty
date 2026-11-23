import type { ToolThinkingEntry } from "../../components/chat/tools/tool-renderer.ts";
import { agentReplyCopyText, agentReplyMessageGroups } from "./agent-reply-copy.ts";
import type { SessionConnection } from "./session-connection.ts";
import type { sessionPanePresentation } from "./session-pane-presentation.ts";
import { type SessionExecutionMessage, sessionExecutionStates } from "./session-presentation.ts";
import {
    agentReplySections,
    hasRunningProcessWork,
    isGeneratingProcessRenderItem,
    type ReplyContentSection,
    type SessionRenderItem,
    sessionRenderGroups,
    sessionRenderItemId,
    sessionRenderItems,
} from "./session-render-items.ts";

type SessionPanePresentation = ReturnType<typeof sessionPanePresentation>;

type SessionTimelineGroup =
    | {
          readonly kind: "user";
          readonly id: string;
          readonly item: SessionRenderItem;
          readonly active: boolean;
          readonly followsUserMessage: boolean;
      }
    | {
          readonly kind: "agent-reply";
          readonly id: string;
          readonly active: boolean;
          readonly activeItemId: string | null;
          readonly sections: readonly ReplyContentSection[];
          readonly workingSectionId: string | null;
          readonly copyText: string | null;
          readonly forkOffered: boolean;
      };

export interface SessionTimelinePresentation {
    readonly groups: readonly SessionTimelineGroup[];
    readonly loading: boolean;
    readonly emptyHistory: boolean;
    readonly workingIndicator: SessionPanePresentation["workingIndicator"];
}

/**
 * Derives the timeline the pane shows from the Session's messages and the pane's presentation. A reply generates while
 * the Session's turn runs and the reply ends the timeline; a generation the Agent drives natively reports no turn, so
 * its running tools are the only sign that it still works.
 */
export function sessionTimelinePresentation(
    messages: readonly SessionExecutionMessage[],
    presentation: Pick<
        SessionPanePresentation,
        | "activity"
        | "awaitingMessage"
        | "confirmedMessages"
        | "historyLoading"
        | "outputState"
        | "pendingDelivery"
        | "queuedMessages"
        | "workingIndicator"
    >,
    connection: SessionConnection["kind"],
    isFileEdit: (entry: ToolThinkingEntry) => boolean,
    forkSupported: boolean,
): SessionTimelinePresentation {
    const working = presentation.activity.kind === "working";
    const renderItems = sessionRenderItems(messages);
    const executionStates = sessionExecutionStates(messages, working);
    const executionStateById = new Map(
        messages.flatMap((message, index) => {
            const state = executionStates[index];
            return state === undefined ? [] : [[message.firstEvent.eventId, state] as const];
        }),
    );
    const replyMessagesById = new Map(
        agentReplyMessageGroups(messages).map((group) => [group.id, group.messages] as const),
    );
    const generationActive = presentation.workingIndicator !== null && working;
    const activeItem = generationActive ? renderItems.at(-1) : undefined;
    const activeItemId = activeItem === undefined ? null : sessionRenderItemId(activeItem);
    const renderGroups = sessionRenderGroups(renderItems);
    const sessionAtRest =
        presentation.outputState === "idle" &&
        presentation.awaitingMessage === null &&
        presentation.confirmedMessages.length === 0 &&
        presentation.pendingDelivery === null &&
        presentation.queuedMessages.length === 0;
    const groups = renderGroups.map((group, groupIndex): SessionTimelineGroup => {
        if (group.kind === "user") {
            return {
                kind: "user",
                id: group.id,
                item: group.item,
                active: activeItemId === group.id,
                followsUserMessage:
                    groupIndex === 0
                        ? presentation.awaitingMessage !== null
                        : renderGroups[groupIndex - 1]?.kind === "user",
            };
        }
        const replyActive = activeItem !== undefined && group.items.at(-1) === activeItem;
        const sections = agentReplySections(group.items, isFileEdit);
        const lastSection = sections.at(-1);
        const copyText = agentReplyCopyText(
            replyMessagesById.get(group.id) ?? [],
            executionStateById.get(group.id) ?? { kind: "open" },
            replyActive || hasRunningProcessWork(group.items),
        );
        return {
            kind: "agent-reply",
            id: group.id,
            active: replyActive,
            activeItemId: replyActive ? activeItemId : null,
            sections,
            workingSectionId:
                replyActive && lastSection?.kind === "process" && lastSection.items.some(isGeneratingProcessRenderItem)
                    ? lastSection.id
                    : null,
            copyText,
            // A fork copies the whole Session, so only the reply that ends it offers one; an earlier reply would promise
            // a fork from that point.
            forkOffered: forkSupported && sessionAtRest && copyText !== null && groupIndex === renderGroups.length - 1,
        };
    });
    const loading = connection === "first-loading" && messages.length === 0 && presentation.awaitingMessage === null;
    return {
        groups,
        loading,
        emptyHistory:
            !loading &&
            presentation.awaitingMessage === null &&
            presentation.confirmedMessages.length === 0 &&
            messages.length === 0 &&
            connection === "ready" &&
            presentation.activity.kind === "idle" &&
            !presentation.historyLoading,
        workingIndicator:
            presentation.workingIndicator !== null && presentation.outputState !== "idle" && working
                ? presentation.workingIndicator
                : null,
    };
}
