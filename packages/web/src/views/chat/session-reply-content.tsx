import { Fragment, type ReactNode } from "react";
import { chatSessionAgentReplyGroupClassName } from "../../components/chat/chat-session-layout.ts";
import { ResponseCopyButton } from "../../components/chat/response-copy-button.tsx";
import { TurnWorkDisclosure } from "../../components/chat/turn-work-disclosure.tsx";
import { cn } from "../../lib/utils.ts";
import { createResponseCopyStore } from "../../view-models/chat/response-copy-store.ts";
import {
    type ReplyContentSection,
    type SessionRenderItem,
    sessionRenderItemId,
} from "../../view-models/chat/session-render-items.ts";

type ReplyItemSpacing = "alert" | "block" | "text";

function replyItemSpacing(item: SessionRenderItem): ReplyItemSpacing {
    if (item.kind === "assistant-text") {
        return "text";
    }
    if (item.kind === "event" && item.message.role === "assistant" && item.message.presentation.kind === "failure") {
        return "alert";
    }
    return "block";
}

const replyItemSpacingMargins: Record<ReplyItemSpacing, { readonly mb: string; readonly mt: string }> = {
    alert: { mb: "mb-4", mt: "mt-4" },
    block: { mb: "mb-3", mt: "mt-3" },
    text: { mb: "", mt: "" },
};

function replyItemMarginClassName(spacing: ReplyItemSpacing, first: boolean, last: boolean): string {
    const margins = replyItemSpacingMargins[spacing];
    return cn(first ? "" : margins.mt, last ? "" : margins.mb);
}

export function SessionReplyContent({
    active = false,
    activeItemId = null,
    copyText,
    sections,
    workingSectionId = null,
    renderItem,
}: {
    readonly active?: boolean;
    readonly activeItemId?: string | null;
    readonly copyText: string | null;
    readonly sections: readonly ReplyContentSection[];
    readonly workingSectionId?: string | null;
    readonly renderItem: (item: SessionRenderItem, active: boolean) => ReactNode;
}) {
    const itemNode = (item: SessionRenderItem, spacingClassName: string) => (
        <div className={spacingClassName} key={sessionRenderItemId(item)}>
            {renderItem(item, sessionRenderItemId(item) === activeItemId)}
        </div>
    );
    // Flatten children before assigning margins so a trailing copy row also takes part in spacing.
    const children: {
        readonly id: string;
        readonly render: (className: string) => ReactNode;
        readonly spacing: ReplyItemSpacing;
    }[] = [];
    for (const section of sections) {
        if (section.kind === "process") {
            children.push({
                id: section.id,
                render: (className) => (
                    <TurnWorkDisclosure
                        className={className}
                        summary={section.summary}
                        working={section.id === workingSectionId}
                    >
                        {section.items.map((item, index) =>
                            itemNode(
                                item,
                                replyItemMarginClassName(
                                    replyItemSpacing(item),
                                    index === 0,
                                    index === section.items.length - 1,
                                ),
                            ),
                        )}
                    </TurnWorkDisclosure>
                ),
                spacing: "block",
            });
            continue;
        }
        for (const item of section.items) {
            children.push({
                id: sessionRenderItemId(item),
                render: (className) => itemNode(item, className),
                spacing: replyItemSpacing(item),
            });
        }
    }
    const childCount = children.length + (copyText === null ? 0 : 1);
    return (
        <article aria-label="Agent response" className={cn(chatSessionAgentReplyGroupClassName, active && "pb-3")}>
            {children.map((child, index) => (
                <Fragment key={child.id}>
                    {child.render(replyItemMarginClassName(child.spacing, index === 0, index === childCount - 1))}
                </Fragment>
            ))}
            {copyText !== null && <ResponseCopyButton createStore={createResponseCopyStore} text={copyText} />}
        </article>
    );
}
