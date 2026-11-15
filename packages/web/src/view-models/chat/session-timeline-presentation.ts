import type { ToolThinkingEntry } from "../../components/chat/tools/tool-renderer.ts";
import { agentReplyCopyText, agentReplyMessageGroups } from "./agent-reply-copy.ts";
import type { SessionConnection } from "./session-connection.ts";
import type { sessionPanePresentation } from "./session-pane-store.ts";
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
          /** The running generation writes this message now. */
          readonly active: boolean;
          /** The message directly follows another user message. */
          readonly followsUserMessage: boolean;
      }
    | {
          readonly kind: "agent-reply";
          readonly id: string;
          /** The running generation writes this reply. */
          readonly active: boolean;
          /** The item the running generation writes now, if it is in this reply. */
          readonly activeItemId: string | null;
          readonly sections: readonly ReplyContentSection[];
          /** The process section the running generation still works in, if it is in this reply. */
          readonly workingSectionId: string | null;
          /** The reply's answer to copy, once the reply stopped generating. */
          readonly copyText: string | null;
      };

/** The Session's timeline as the pane shows it: which reply the Agent still generates, and what stands in for history. */
export interface SessionTimelinePresentation {
    readonly groups: readonly SessionTimelineGroup[];
    /** The Session's first read has not shown anything yet. */
    readonly loading: boolean;
    /** The Computer holds no history for the Session, and nothing is on its way. */
    readonly emptyHistory: boolean;
    /** What the timeline ends with while the Agent works on the Session's turn. */
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
        "activity" | "awaitingMessage" | "confirmedMessages" | "historyLoading" | "outputState" | "workingIndicator"
    >,
    connection: SessionConnection["kind"],
    isFileEdit: (entry: ToolThinkingEntry) => boolean,
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
            copyText: agentReplyCopyText(
                replyMessagesById.get(group.id) ?? [],
                executionStateById.get(group.id) ?? { kind: "open" },
                replyActive || hasRunningProcessWork(group.items),
            ),
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
