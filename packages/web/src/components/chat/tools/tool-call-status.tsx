import { Check, ChevronDown, CircleMinus, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { cn } from "../../../lib/utils.ts";
import { ScrollEdgeFade } from "../../utils/scroll-edge-fade.tsx";
import type { ToolCallState } from "./tool-renderer.ts";

export const ToolCallSupplementalContent = createContext<ReactNode>(null);

/** Shared trigger row for intermediate agent steps (thinking rail + tool calls). */
export const agentThinkStepTriggerClassName =
    "group/process -mx-2 flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] leading-[22px] text-morty-text-3 outline-none hover:text-copy-secondary active:text-copy-secondary focus-visible:text-copy-secondary keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60";

export const agentThinkStepIconClassName = "flex size-[18px] shrink-0 items-center justify-center [&>svg]:size-3.5";

export const agentThinkStepTitleClassName = "min-w-0 truncate text-left";

export const agentThinkStepWorkingTextClassName =
    "animate-loading-text-shimmer bg-[linear-gradient(90deg,#8a8f98_0%,#8a8f98_35%,#fafafb_50%,#8a8f98_65%,#8a8f98_100%)] bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-morty-text-3";

export const agentThinkStepInlineLabelClassName = "flex min-w-0 flex-1 items-center gap-1";

/** Chevron reserves fixed width and appears on hover, focus, or open without shifting the title. */
export const agentThinkStepChevronClassName =
    "invisible size-3.5 shrink-0 -rotate-90 transition-[rotate,transform,visibility] group-hover/process:visible group-focus-visible/process:visible motion-reduce:transition-none";

export const agentThinkStepExpandedPanelClassName =
    "grid max-h-[280px] min-w-0 gap-2 border-l border-[#d9dde1] py-2 pl-5 [overflow-wrap:anywhere]";

/** Scrollport for a collapsed step. Fades only the edge that still clips content. */
export function AgentThinkStepExpandedPanel({ children }: { readonly children: ReactNode }) {
    return (
        <ScrollEdgeFade
            className={agentThinkStepExpandedPanelClassName}
            fadeFromClassName="from-card"
            fadeToClassName="to-card/0"
            frameClassName="mb-1 ml-2 min-w-0"
        >
            {children}
        </ScrollEdgeFade>
    );
}

const toolCallStatusIconClassName = "block shrink-0";

const toolCallStatusRenderedStrokePx = 1.3;

/** Lucide strokes scale with icon size (viewBox 24). */
const toolCallStatusStrokeWidthAt12Px = (toolCallStatusRenderedStrokePx * 24) / 12;

const toolCallStatusSlotClassName = "inline-flex shrink-0 items-center justify-center leading-[22px]";

export function ToolCallDisclosure({
    ariaLabel,
    children,
    icon,
    state,
    testId,
    title,
}: {
    readonly ariaLabel: string;
    readonly children?: ReactNode;
    readonly icon: ReactNode;
    readonly state: ToolCallState;
    readonly testId?: string | undefined;
    readonly title: string;
}) {
    const [open, setOpen] = useState(false);
    const supplementalContent = useContext(ToolCallSupplementalContent);
    return (
        <fieldset aria-label={ariaLabel} className="group/tool m-0 min-w-0 border-0 p-0" data-testid={testId}>
            <button
                aria-expanded={open}
                className={cn(agentThinkStepTriggerClassName, "group/trigger items-center")}
                onClick={() => setOpen((current) => !current)}
                title={title}
                type="button"
            >
                <span className={agentThinkStepIconClassName}>{icon}</span>
                <span className={cn(agentThinkStepInlineLabelClassName, "overflow-hidden leading-[22px]")}>
                    <span className={agentThinkStepTitleClassName}>{title}</span>
                    <span className={toolCallStatusSlotClassName}>
                        <ToolCallStatus state={state} />
                    </span>
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(agentThinkStepChevronClassName, open && "visible rotate-0")}
                    />
                </span>
            </button>
            {open && (
                <AgentThinkStepExpandedPanel>
                    {children}
                    {supplementalContent}
                </AgentThinkStepExpandedPanel>
            )}
        </fieldset>
    );
}

export function ToolCallStatus({ state }: { readonly state: ToolCallState }) {
    switch (state.kind) {
        case "background": {
            const labels = {
                running: "Running in background",
                completed: "Completed",
                failed: "Failed",
                stopped: "Stopped",
                unknown: "Status unknown",
            };
            return <span className="ml-1 whitespace-nowrap text-xs">{labels[state.status]}</span>;
        }
        case "running":
            return <span aria-label="Tool running" className="sr-only" role="img" />;
        case "succeeded":
            return (
                <Check
                    aria-label="Tool succeeded"
                    className={cn(toolCallStatusIconClassName, "size-3 text-success")}
                    strokeWidth={toolCallStatusStrokeWidthAt12Px}
                />
            );
        case "failed":
            return (
                <X
                    aria-label="Tool failed"
                    className={cn(toolCallStatusIconClassName, "size-3 text-destructive")}
                    strokeWidth={toolCallStatusStrokeWidthAt12Px}
                />
            );
        case "interrupted":
            return (
                <CircleMinus
                    aria-label="Tool interrupted"
                    className={cn(toolCallStatusIconClassName, "size-3")}
                    strokeWidth={toolCallStatusStrokeWidthAt12Px}
                />
            );
        case "unknown":
            return null;
    }
}
