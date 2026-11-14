import { Brain, ChevronDown, Wrench } from "lucide-react";
import { useRef, useState } from "react";
import type { MarkdownImageReader } from "../../components/agents/agent-markdown.tsx";
import { ToolTextPreview } from "../../components/chat/tool-text-preview.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { AgentRichContent } from "../agents/agent-rich-content.tsx";
import type { SessionResourceStoreFactory } from "../agents/resource-reader.ts";
import { FollowLatestScrollArea } from "../utils/follow-latest-scroll-area.tsx";
import { useScrollClippedEdges } from "../utils/use-scroll-clipped-edges.ts";
import { type DisclosureChoice, disclosureOpen } from "./disclosure-choice.ts";
import {
    agentThinkStepChevronClassName,
    agentThinkStepExpandedPanelClassName,
    agentThinkStepIconClassName,
    agentThinkStepInlineLabelClassName,
    agentThinkStepTitleClassName,
    agentThinkStepTriggerClassName,
    ToolCallDisclosure,
    ToolCallSupplementalContent,
} from "./tools/tool-call-status.tsx";
import { REASONING_CHARACTER_LIMIT, type SessionToolPresentation } from "./tools/tool-contract.ts";
import { toolRichContent } from "./tools/tool-display-content.ts";
import { renderRegisteredTool } from "./tools/tool-renderer-registry.tsx";

export type AgentThinkingEntry =
    | {
          readonly id: string;
          readonly kind: "reasoning";
          readonly messageId: string | null;
          readonly text: string;
          readonly truncated: boolean;
      }
    | SessionToolPresentation;

type ReasoningEntry = Extract<AgentThinkingEntry, { readonly kind: "reasoning" }>;
type TimelineEntry =
    | { readonly entry: ReasoningEntry; readonly kind: "reasoning" }
    | { readonly entry: SessionToolPresentation; readonly kind: "tool" };

const clippedEdgeThresholdPx = 4;

function ReasoningContent({ entry }: { readonly entry: ReasoningEntry }) {
    const content = useRef<HTMLDivElement>(null);
    const clipped = useScrollClippedEdges(content, clippedEdgeThresholdPx);
    return (
        <div className="relative mb-1 ml-2 min-h-0">
            <FollowLatestScrollArea
                className={cn(agentThinkStepExpandedPanelClassName, "pt-1")}
                container={content}
                followThreshold={24}
                followRevision={null}
            >
                <section className="grid min-w-0 gap-2">
                    {entry.truncated && (
                        <p className="m-0 text-xs leading-5 text-copy-secondary">
                            Earlier reasoning was truncated to the most recent 16K characters.
                        </p>
                    )}
                    {entry.text.trim().length > 0 && (
                        <pre className="m-0 whitespace-pre-wrap font-sans text-12 text-muted-foreground">
                            {entry.text}
                        </pre>
                    )}
                </section>
            </FollowLatestScrollArea>
            <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-card to-card/0 transition-opacity duration-150 motion-reduce:transition-none ${clipped.top ? "opacity-100" : "opacity-0"}`}
            />
            <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-card to-card/0 transition-opacity duration-150 motion-reduce:transition-none ${clipped.bottom ? "opacity-100" : "opacity-0"}`}
            />
        </div>
    );
}

function ReasoningDisclosure({ active, entry }: { readonly active: boolean; readonly entry: ReasoningEntry }) {
    const [choice, setChoice] = useState<DisclosureChoice>("unset");
    const open = disclosureOpen(choice, active);
    return (
        <details
            aria-label="Agent thinking"
            className="group/thinking min-w-0"
            data-testid={dataTestId.agentReasoning}
            onToggle={(event) => {
                if (event.currentTarget.open !== open) {
                    setChoice(event.currentTarget.open ? "expanded" : "collapsed");
                }
            }}
            open={open}
        >
            <summary
                className={`${agentThinkStepTriggerClassName} group/summary list-none [&::-webkit-details-marker]:hidden`}
            >
                <span className={agentThinkStepIconClassName}>
                    <Brain aria-hidden="true" className="size-3.5 shrink-0" />
                </span>
                <span className={agentThinkStepInlineLabelClassName}>
                    <span className={cn(agentThinkStepTitleClassName, "leading-snug [overflow-wrap:anywhere]")}>
                        Show Thinking
                    </span>
                    <ChevronDown
                        aria-hidden="true"
                        className={`${agentThinkStepChevronClassName} group-open/thinking:visible group-open/thinking:rotate-0`}
                    />
                </span>
            </summary>
            {open && <ReasoningContent entry={entry} />}
        </details>
    );
}

function ToolCall({
    entry,
    createResourceStore,
    readImage,
}: {
    readonly entry: SessionToolPresentation;
    readonly createResourceStore?: SessionResourceStoreFactory | undefined;
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    const registered = renderRegisteredTool(entry);
    const supplementalContent = (
        <AgentRichContent
            contents={toolRichContent(entry.content)}
            createResourceStore={createResourceStore}
            readImage={readImage}
        />
    );
    if (registered !== null) {
        return <ToolCallSupplementalContent value={supplementalContent}>{registered}</ToolCallSupplementalContent>;
    }
    return (
        <ToolCallSupplementalContent value={supplementalContent}>
            <ToolCallDisclosure
                ariaLabel={`Tool: ${entry.title}`}
                icon={<Wrench aria-hidden="true" className="size-3.5 shrink-0" />}
                state={entry.state}
                testId={dataTestId.agentToolCall}
                title={entry.title}
            >
                <div className="grid min-w-0 gap-2 text-xs">
                    {entry.input.length > 0 && (
                        <div className="grid gap-1">
                            <span className="font-medium text-copy-tertiary">Request</span>
                            <ToolTextPreview text={entry.input} />
                        </div>
                    )}
                    {entry.output.length > 0 && (
                        <div className="grid gap-1">
                            <span className="font-medium text-copy-tertiary">Response</span>
                            <ToolTextPreview text={entry.output} />
                        </div>
                    )}
                </div>
            </ToolCallDisclosure>
        </ToolCallSupplementalContent>
    );
}

export function AgentThinking({
    active,
    createResourceStore,
    entries,
    readImage,
}: {
    readonly active: boolean;
    /** The view-model resource store factory; without it remote images render as links. */
    readonly createResourceStore?: SessionResourceStoreFactory | undefined;
    readonly entries: readonly AgentThinkingEntry[];
    readonly readImage?: MarkdownImageReader | undefined;
}) {
    if (entries.length === 0) {
        return null;
    }
    const timeline: TimelineEntry[] = [];
    let reasoning: ReasoningEntry[] = [];
    const flushReasoning = (): void => {
        const first = reasoning[0];
        if (first === undefined) {
            return;
        }
        let messageId = first.messageId;
        const text = [first.text];
        for (const entry of reasoning.slice(1)) {
            if (entry.messageId !== messageId) {
                text.push("\n\n");
            }
            text.push(entry.text);
            messageId = entry.messageId;
        }
        const combined = text.join("");
        timeline.push({
            entry: {
                ...first,
                text: combined.slice(-REASONING_CHARACTER_LIMIT),
                truncated: reasoning.some((entry) => entry.truncated) || combined.length > REASONING_CHARACTER_LIMIT,
            },
            kind: "reasoning",
        });
        reasoning = [];
    };
    for (const entry of entries) {
        if (entry.kind === "reasoning") {
            reasoning.push(entry);
        } else {
            flushReasoning();
            timeline.push({ entry, kind: "tool" });
        }
    }
    flushReasoning();
    const currentEntry = timeline.at(-1);
    return (
        <div className="grid min-w-0 gap-0 py-0.5 text-[13px] leading-[22px] text-muted-foreground">
            {timeline.map((item) =>
                item.kind === "reasoning" ? (
                    <ReasoningDisclosure
                        active={active && item === currentEntry}
                        entry={item.entry}
                        key={`reasoning:${item.entry.id}`}
                    />
                ) : (
                    <ToolCall
                        createResourceStore={createResourceStore}
                        entry={item.entry}
                        key={`tool:${item.entry.id}`}
                        readImage={readImage}
                    />
                ),
            )}
        </div>
    );
}
