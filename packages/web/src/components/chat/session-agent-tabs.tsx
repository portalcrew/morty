import { Tabs } from "radix-ui";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { HarnessMark } from "./harness-mark.tsx";

export const sessionAgentTabsListClassName =
    "flex h-12 w-full min-w-0 gap-0.5 rounded-full bg-morty-fill-opacity-2 p-0.5 sm:h-9";

/** Icon-only tab footprint; shared with the loading skeleton. */
export const sessionAgentTabInactiveLayoutClassName =
    "box-border flex h-full w-16 max-w-16 min-w-0 shrink grow-0 items-center justify-center px-2.5 sm:w-10 sm:max-w-10 sm:shrink-0 sm:px-1.5";

/** Selected tab footprint; mirrors the trigger's active state for the loading skeleton. */
export const sessionAgentTabSelectedLayoutClassName =
    "box-border flex h-full min-w-0 flex-1 shrink grow items-center justify-center rounded-full px-2.5";

const sessionAgentTabTriggerClassName = cn(
    "group relative gap-1.5 rounded-full border border-transparent text-[15px] text-copy-secondary outline-none transition-[flex-grow,background-color,color,border-color] duration-200 hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:hover:bg-transparent data-[state=inactive]:hover:bg-morty-fill-opacity-3 data-[state=active]:border-white data-[state=active]:bg-card data-[state=active]:font-medium data-[state=active]:text-foreground motion-reduce:transition-none sm:text-[13px]",
    sessionAgentTabInactiveLayoutClassName,
    "data-[state=active]:max-w-none data-[state=active]:min-w-0 data-[state=active]:flex-1 data-[state=active]:shrink data-[state=active]:grow data-[state=active]:px-2.5",
);

export function SessionAgentTabs({
    agents,
    className,
    dimInactive = true,
    disabled,
    onValueChange,
    value,
}: {
    readonly agents: readonly {
        readonly harness: string;
        readonly installed?: boolean;
        readonly label: string;
    }[];
    readonly className?: string;
    /** When false, inactive tabs stay at full opacity (e.g. while the directory is refreshing). */
    readonly dimInactive?: boolean;
    readonly disabled: boolean;
    readonly onValueChange: (value: string) => void;
    readonly value: string;
}) {
    return (
        <Tabs.Root className={className} onValueChange={onValueChange} value={value}>
            <Tabs.List aria-label="Session agent" className={sessionAgentTabsListClassName}>
                {agents.map((agent) => {
                    const optionValue = agent.harness;
                    const installed = agent.installed !== false;
                    return (
                        <Tabs.Trigger
                            className={cn(
                                sessionAgentTabTriggerClassName,
                                dimInactive &&
                                    "disabled:opacity-50 data-[state=inactive]:opacity-60 data-[state=inactive][data-installed=false]:opacity-45",
                            )}
                            data-installed={installed ? "true" : "false"}
                            disabled={disabled}
                            key={optionValue}
                            title={installed ? agent.label : `${agent.label} (not installed)`}
                            value={optionValue}
                        >
                            <HarnessMark
                                harness={agent.harness}
                                className="max-sm:size-5 max-sm:[&>svg]:size-[13px]"
                                label={agent.label}
                                testId={dataTestId.harnessMark}
                            />
                            <span className="min-w-0 truncate group-data-[state=inactive]:sr-only">{agent.label}</span>
                            {!installed && <span className="sr-only">not installed</span>}
                        </Tabs.Trigger>
                    );
                })}
            </Tabs.List>
        </Tabs.Root>
    );
}
