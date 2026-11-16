import { ChevronDown, FileText } from "lucide-react";
import { useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { type DisclosureChoice, disclosureOpen } from "./disclosure-choice.ts";
import {
    AgentThinkStepExpandedPanel,
    agentThinkStepChevronClassName,
    agentThinkStepIconClassName,
    agentThinkStepInlineLabelClassName,
    agentThinkStepTitleClassName,
    agentThinkStepTriggerClassName,
    ToolCallStatus,
} from "./tools/tool-call-status.tsx";
import type { ToolCallState } from "./tools/tool-renderer.ts";

export type CompactionStatusState = "in_progress" | "completed" | "failed" | "cancelled";

const toolCallStatusSlotClassName = "inline-flex shrink-0 items-center justify-center leading-[22px]";

function compactionStatusToToolState(status: CompactionStatusState): ToolCallState {
    switch (status) {
        case "in_progress":
            return { kind: "running" };
        case "completed":
            return { kind: "succeeded" };
        case "failed":
            return { kind: "failed" };
        case "cancelled":
            return { kind: "interrupted" };
    }
}

export function CompactionDisclosure({
    error,
    status,
    summary,
}: {
    readonly error: string | null;
    readonly status: CompactionStatusState;
    readonly summary: string;
}) {
    const [choice, setChoice] = useState<DisclosureChoice>("unset");
    const open = disclosureOpen(choice, status === "in_progress");
    const title = "Context compaction";
    return (
        <fieldset
            aria-label="Context compaction"
            className="group/tool m-0 min-w-0 border-0 p-0"
            data-testid={dataTestId.agentCompaction}
        >
            <button
                aria-expanded={open}
                className={cn(agentThinkStepTriggerClassName, "group/trigger items-center")}
                onClick={() => setChoice(open ? "collapsed" : "expanded")}
                title={title}
                type="button"
            >
                <span className={agentThinkStepIconClassName}>
                    <FileText aria-hidden="true" className="size-3.5 shrink-0" />
                </span>
                <span className={cn(agentThinkStepInlineLabelClassName, "overflow-hidden leading-[22px]")}>
                    <span className={agentThinkStepTitleClassName}>{title}</span>
                    <span className={toolCallStatusSlotClassName}>
                        <ToolCallStatus state={compactionStatusToToolState(status)} />
                    </span>
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(agentThinkStepChevronClassName, open && "visible rotate-0")}
                    />
                </span>
            </button>
            {open && (
                <AgentThinkStepExpandedPanel>
                    <section className="grid min-w-0 gap-2">
                        {error !== null && error.length > 0 && (
                            <p className="m-0 text-xs text-destructive" role="alert">
                                {error}
                            </p>
                        )}
                        {summary.trim().length > 0 && (
                            <pre className="m-0 whitespace-pre-wrap font-sans text-xs leading-5 text-copy-secondary [overflow-wrap:anywhere]">
                                {summary}
                            </pre>
                        )}
                    </section>
                </AgentThinkStepExpandedPanel>
            )}
        </fieldset>
    );
}
