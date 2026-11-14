import type { AgentQuestion } from "@morty-build/client/protocol";
import type { AgentThinkingEntry } from "../../components/chat/agent-thinking.tsx";
import type { ToolThinkingEntry } from "../../components/chat/tools/tool-renderer.ts";
import type { TurnWorkSummary } from "../../components/chat/turn-work-disclosure.tsx";
import { openAgentQuestions } from "./agent-question-answer.ts";
import { type SessionMessage, sessionTextValue } from "./session-presentation.ts";

// How a Session's messages read as a conversation: adjacent text, thinking and tool rows merge into render items, which
// group into the user's messages and the Agent's replies, whose process work folds into sections. Each takes the
// messages it needs and returns the result, so what the page shows follows from the messages alone.

export type SessionRenderItem =
    | {
          readonly kind: "assistant-text";
          readonly id: string;
          readonly messageId: string | null;
          readonly text: string;
          readonly questions: readonly AgentQuestion[];
          /** No user message followed the questions yet. */
          readonly answerable: boolean;
      }
    | {
          readonly kind: "event";
          readonly message: SessionMessage;
      }
    | {
          readonly entries: readonly AgentThinkingEntry[];
          readonly id: string;
          readonly kind: "thinking";
      };

function assistantText(message: SessionMessage): {
    readonly messageId: string | null;
    readonly questions: readonly AgentQuestion[];
    readonly text: string;
} | null {
    if (
        message.role === "assistant" &&
        message.presentation.kind === "message" &&
        message.presentation.content.type === "text"
    ) {
        return {
            messageId: message.presentation.messageId,
            questions: message.presentation.questions,
            text: sessionTextValue(message.presentation.content.text),
        };
    }
    return null;
}

function thinkingEntry(message: SessionMessage): AgentThinkingEntry | null {
    if (message.role !== "assistant") {
        return null;
    }
    if (message.presentation.kind === "tool") {
        return message.presentation.entry;
    }
    if (message.presentation.kind === "thought" && message.presentation.content.type === "text") {
        return {
            id: message.firstEvent.eventId,
            kind: "reasoning",
            messageId: message.presentation.messageId,
            text: sessionTextValue(message.presentation.content.text),
            truncated: message.presentation.content.text.truncated,
        };
    }
    return null;
}

export function sessionRenderItems(messages: readonly SessionMessage[]): readonly SessionRenderItem[] {
    type RenderItemBuilder =
        | {
              kind: "assistant-text";
              id: string;
              messageId: string | null;
              questions: readonly AgentQuestion[];
              text: string[];
          }
        | { readonly kind: "event"; readonly message: SessionMessage }
        | { entries: AgentThinkingEntry[]; readonly id: string; readonly kind: "thinking" };
    const items: RenderItemBuilder[] = [];
    for (const message of messages) {
        const text = assistantText(message);
        const thinking = thinkingEntry(message);
        const previous = items.at(-1);
        if (text !== null && previous?.kind === "assistant-text" && previous.messageId === text.messageId) {
            previous.text.push(text.text);
            if (previous.questions.length === 0) {
                previous.questions = text.questions;
            }
        } else if (text !== null) {
            items.push({
                kind: "assistant-text",
                id: message.firstEvent.eventId,
                messageId: text.messageId,
                questions: text.questions,
                text: [text.text],
            });
        } else if (thinking !== null && previous?.kind === "thinking") {
            previous.entries.push(thinking);
        } else if (thinking !== null) {
            items.push({ entries: [thinking], id: message.firstEvent.eventId, kind: "thinking" });
        } else {
            items.push({ kind: "event", message });
        }
    }
    const open = openAgentQuestions(messages);
    return items.map(
        (item): SessionRenderItem =>
            item.kind === "assistant-text"
                ? {
                      ...item,
                      answerable: item.messageId !== null && open.has(item.messageId),
                      text: item.text.join(""),
                  }
                : item,
    );
}

export type SessionRenderGroup =
    | {
          readonly id: string;
          readonly items: readonly SessionRenderItem[];
          readonly kind: "agent-reply";
      }
    | {
          readonly id: string;
          readonly item: SessionRenderItem;
          readonly kind: "user";
      };

export function sessionRenderItemId(item: SessionRenderItem): string {
    return item.kind === "event" ? item.message.firstEvent.eventId : item.id;
}

function isUserSessionRenderItem(item: SessionRenderItem): boolean {
    return item.kind === "event" && item.message.role === "user";
}

export function sessionRenderGroups(items: readonly SessionRenderItem[]): readonly SessionRenderGroup[] {
    const groups: SessionRenderGroup[] = [];
    let replyItems: SessionRenderItem[] = [];

    const flushReplyGroup = (): void => {
        if (replyItems.length === 0) {
            return;
        }
        const firstReplyItem = replyItems.at(0);
        if (firstReplyItem === undefined) {
            return;
        }
        groups.push({ id: sessionRenderItemId(firstReplyItem), items: replyItems, kind: "agent-reply" });
        replyItems = [];
    };

    for (const item of items) {
        if (isUserSessionRenderItem(item)) {
            flushReplyGroup();
            groups.push({ id: sessionRenderItemId(item), item, kind: "user" });
        } else {
            replyItems.push(item);
        }
    }
    flushReplyGroup();
    return groups;
}

export type ReplyContentSection =
    | {
          readonly id: string;
          readonly items: readonly SessionRenderItem[];
          readonly kind: "visible";
      }
    | {
          readonly id: string;
          readonly items: readonly SessionRenderItem[];
          readonly kind: "process";
          readonly summary: TurnWorkSummary;
      };

function isProcessRenderItem(item: SessionRenderItem): boolean {
    // Compaction already has its own summary disclosure. Keep its marker visible
    // at the native event position rather than burying it in a process group.
    return item.kind === "thinking";
}

export function isGeneratingProcessRenderItem(item: SessionRenderItem): boolean {
    if (item.kind === "thinking") {
        const current = item.entries.at(-1);
        return (
            current?.kind === "reasoning" ||
            current?.state.kind === "running" ||
            (current?.state.kind === "background" && current.state.status === "running")
        );
    }
    return (
        item.kind === "event" &&
        item.message.role === "assistant" &&
        item.message.presentation.kind === "compaction" &&
        item.message.presentation.status === "in_progress"
    );
}

/**
 * Whether a reply still has process work in flight. A generation the Agent drives natively reports no Morty turn,
 * so its reply settles only when every tool it started has an outcome; settled imports interrupt unresolved tools
 * when the Session opens, so this stays false for finished history.
 */
export function hasRunningProcessWork(items: readonly SessionRenderItem[]): boolean {
    return items.some((item) => {
        if (item.kind === "thinking") {
            return item.entries.some(
                (entry) =>
                    entry.kind === "tool" &&
                    (entry.state.kind === "running" ||
                        (entry.state.kind === "background" && entry.state.status === "running")),
            );
        }
        return (
            item.kind === "event" &&
            item.message.role === "assistant" &&
            item.message.presentation.kind === "compaction" &&
            item.message.presentation.status === "in_progress"
        );
    });
}

function processSummary(
    items: readonly SessionRenderItem[],
    isFileEdit: (entry: ToolThinkingEntry) => boolean,
): TurnWorkSummary {
    const entries = items.flatMap((item) => (item.kind === "thinking" ? item.entries : []));
    const tools = entries.filter((entry) => entry.kind === "tool");
    return {
        backgroundRunning: tools.filter((tool) => tool.state.kind === "background" && tool.state.status === "running")
            .length,
        backgroundUnknown: tools.filter((tool) => tool.state.kind === "background" && tool.state.status === "unknown")
            .length,
        fileEdits: tools.filter(isFileEdit).length,
        interrupted: tools.filter(
            (entry) =>
                entry.state.kind === "interrupted" ||
                (entry.state.kind === "background" && entry.state.status === "stopped"),
        ).length,
        steps: Math.max(tools.length, items.length),
    };
}

/**
 * Groups adjacent weakened process rows until visible answer text starts the
 * next section. A process section remains disclosed during generation and
 * after completion so the answer leads; its summary carries the live shimmer
 * while the owning execution is still running.
 */
export function agentReplySections(
    items: readonly SessionRenderItem[],
    isFileEdit: (entry: ToolThinkingEntry) => boolean,
): readonly ReplyContentSection[] {
    const sections: ReplyContentSection[] = [];
    let index = 0;
    while (index < items.length) {
        const item = items[index];
        if (item === undefined) {
            break;
        }
        if (isProcessRenderItem(item)) {
            const start = index;
            while (true) {
                const candidate = items[index];
                if (candidate === undefined || !isProcessRenderItem(candidate)) {
                    break;
                }
                index += 1;
            }
            const processItems = items.slice(start, index);
            const summary = processSummary(processItems, isFileEdit);
            sections.push({
                id: `process:${sessionRenderItemId(processItems[0] ?? item)}`,
                items: processItems,
                kind: "process",
                summary,
            });
            continue;
        }
        const start = index;
        index += 1;
        const visibleItems = items.slice(start, index);
        sections.push({
            id: `visible:${sessionRenderItemId(visibleItems[0] ?? item)}`,
            items: visibleItems,
            kind: "visible",
        });
    }
    return sections;
}
