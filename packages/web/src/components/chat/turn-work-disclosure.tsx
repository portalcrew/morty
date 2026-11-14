import { ChevronDown, ListChecks } from "lucide-react";
import { Fragment, type ReactNode, useId, useState } from "react";
import { cn } from "../../lib/utils.ts";
import { type DisclosureChoice, disclosureOpen } from "./disclosure-choice.ts";
import {
    agentThinkStepChevronClassName,
    agentThinkStepIconClassName,
    agentThinkStepInlineLabelClassName,
    agentThinkStepTitleClassName,
    agentThinkStepTriggerClassName,
    agentThinkStepWorkingTextClassName,
} from "./tools/tool-call-status.tsx";

export interface TurnWorkSummary {
    readonly backgroundRunning: number;
    readonly backgroundUnknown: number;
    readonly fileEdits: number;
    readonly failed: number;
    readonly interrupted: number;
    readonly steps: number;
}

function counted(count: number, singular: string, plural: string): string {
    return `${count.toString()} ${count === 1 ? singular : plural}`;
}

/**
 * Collapses one adjacent process segment (tool calls, reasoning, and progress
 * notes) behind a summary row. The latest generating segment shimmers.
 */
export function TurnWorkDisclosure({
    children,
    className,
    summary,
    working = false,
}: {
    readonly children: ReactNode;
    readonly className?: string | undefined;
    readonly summary: TurnWorkSummary;
    readonly working?: boolean | undefined;
}) {
    const [choice, setChoice] = useState<DisclosureChoice>("unset");
    const open = disclosureOpen(choice, false);
    const contentId = useId();
    const parts: { readonly key: string; readonly text: string; readonly alert: boolean }[] = [
        { key: "steps", text: counted(summary.steps, "step", "steps"), alert: false },
    ];
    if (summary.backgroundRunning > 0) {
        parts.push({
            key: "background-running",
            text: `${summary.backgroundRunning.toString()} running in background`,
            alert: false,
        });
    }
    if (summary.backgroundUnknown > 0) {
        parts.push({
            key: "background-unknown",
            text: `${summary.backgroundUnknown.toString()} status unknown`,
            alert: false,
        });
    }
    if (summary.fileEdits > 0) {
        parts.push({ key: "edits", text: counted(summary.fileEdits, "file edit", "file edits"), alert: false });
    }
    if (summary.interrupted > 0) {
        parts.push({ key: "interrupted", text: `${summary.interrupted.toString()} interrupted`, alert: true });
    }
    return (
        <div className={cn("min-w-0", className)}>
            <button
                aria-controls={contentId}
                aria-expanded={open}
                className={cn(agentThinkStepTriggerClassName, working && "text-morty-text-3")}
                onClick={() => setChoice(open ? "collapsed" : "expanded")}
                type="button"
            >
                <span className={agentThinkStepIconClassName}>
                    <ListChecks aria-hidden="true" className="size-3.5 shrink-0" />
                </span>
                <span className={agentThinkStepInlineLabelClassName}>
                    <span className={agentThinkStepTitleClassName}>
                        <span className={cn(working && agentThinkStepWorkingTextClassName)}>
                            {parts.map((part, index) => (
                                <Fragment key={part.key}>
                                    {index > 0 && " · "}
                                    <span className={cn(part.alert && "text-destructive")}>{part.text}</span>
                                </Fragment>
                            ))}
                        </span>
                    </span>
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(agentThinkStepChevronClassName, open && "visible rotate-0")}
                    />
                </span>
            </button>
            {open && (
                <div className="min-w-0" id={contentId}>
                    {children}
                </div>
            )}
        </div>
    );
}
