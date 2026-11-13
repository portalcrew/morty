import { Check, ChevronDown, LoaderCircle, MonitorCog, Plus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useStore } from "zustand";
import { cn } from "@/lib/utils";
import { MortyLogoMark } from "../../components/brand/morty-logo.tsx";
import { ComputerExecutionDetails } from "../../components/chat/computer-execution-details.tsx";
import type { ExecutionContext } from "../../components/chat/execution-context.ts";
import {
    type OverlayContentOpenAutoFocus,
    overlayMenuSeparatorClassName,
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
    preventOverlayOpenAutoFocus,
} from "../../components/ui/overlay-surface.ts";
import { ScrollArea } from "../../components/ui/scroll-area.tsx";
import { textLinkClassName } from "../../components/ui/text-link.ts";
import { dataTestId } from "../../data-testid.ts";
import type { BotConnectionStatus } from "../../view-models/chat/computer-status-store.ts";
import {
    type ComputerChoice,
    type ComputerSwitcherModel,
    computerSwitcherChoices,
} from "../../view-models/chat/computer-switcher-store.ts";

function connectionLabel(status: BotConnectionStatus): string {
    switch (status.kind) {
        case "connected":
            return "Online";
        case "connecting":
            return "Connecting";
        case "disconnected":
            return "Offline";
        case "unpaired":
            return "Not set up";
        case "revoked":
            return "Run setup again";
        case "unavailable":
            return "Status unknown";
    }
}

/** Why a computer is not online, written in its row; an online computer needs no words. */
function choiceStatusLabel(status: ComputerChoice["status"]): string | null {
    switch (status) {
        case "online":
            return null;
        case "offline":
            return "Offline";
        case "unavailable":
            return "Unavailable";
        case "connecting":
            return "Connecting";
        case "unpaired":
            return "Not set up";
        case "revoked":
            return "Run setup again";
    }
}

/** Online is a filled dot; every other state is a hollow ring, so the state never depends on color alone. */
function StatusDot({
    className,
    online,
    pulsing = false,
}: {
    readonly className?: string;
    readonly online: boolean;
    readonly pulsing?: boolean;
}) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                "size-1.5 shrink-0 rounded-full",
                className,
                online ? "bg-success" : "border-[1.5px] border-muted-foreground/60",
                pulsing && "animate-pulse border-amber-500 motion-reduce:animate-none",
            )}
        />
    );
}

const choiceRowClassName = "grid grid-cols-[1rem_minmax(0,1fr)_auto_1rem] items-center gap-x-2 outline-none";

function ComputerChoiceContent({
    choice,
    current,
    nameClassName,
    statusClassName,
}: {
    readonly choice: ComputerChoice;
    readonly current: boolean;
    readonly nameClassName: string;
    readonly statusClassName: string;
}) {
    const status = choiceStatusLabel(choice.status);
    return (
        <>
            <span className="flex justify-center">
                <StatusDot online={choice.status === "online"} />
                {status === null ? <span className="sr-only">Online</span> : null}
            </span>
            <span
                className={cn(
                    "min-w-0 truncate font-medium",
                    current && "col-span-2",
                    nameClassName,
                    status !== null && "font-normal text-copy-secondary",
                )}
                title={choice.name}
            >
                {choice.name}
            </span>
            <span className={cn("whitespace-nowrap text-morty-text-3", statusClassName, current && "sr-only")}>
                {status}
            </span>
            <span className="flex w-4 justify-center" aria-hidden="true">
                {current ? <Check className="size-3.5" /> : null}
            </span>
        </>
    );
}

const menuRowClassName =
    "h-9 rounded-full px-3 cursor-pointer transition-colors hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 data-[highlighted]:bg-accent motion-reduce:transition-none";

function ComputerMenuChoice({ activeKey, choice }: { readonly activeKey: string; readonly choice: ComputerChoice }) {
    const current = choice.key === activeKey;
    const content = (
        <ComputerChoiceContent choice={choice} current={current} nameClassName="text-14" statusClassName="text-xs" />
    );
    // Choosing the computer the page is already on only closes the menu; it never reloads the page.
    return current ? (
        <DropdownMenu.RadioItem
            className={cn(choiceRowClassName, menuRowClassName)}
            textValue={choice.name}
            value={choice.key}
        >
            {content}
        </DropdownMenu.RadioItem>
    ) : (
        <DropdownMenu.RadioItem asChild textValue={choice.name} value={choice.key}>
            <a className={cn(choiceRowClassName, menuRowClassName)} href={choice.href}>
                {content}
            </a>
        </DropdownMenu.RadioItem>
    );
}

export const mobileDrawerCardClassName =
    "flex min-h-min shrink-0 flex-col overflow-hidden rounded-lg bg-morty-fill-white text-foreground";

export const mobileDrawerOptionDividerClassName = "[&>*+*]:border-t-[0.5px] [&>*+*]:border-black/[0.06]";

export const mobileDrawerCardRowClassName =
    "flex h-12 w-full items-center gap-3 px-4 text-left text-[15px] font-medium text-foreground outline-none transition-colors hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-inset keyboard-focus:focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

const mobileComputersSectionTitleClassName =
    "px-4 pt-3 pb-1 text-[15px] font-semibold leading-5 tracking-[-0.015em] text-foreground";

const mobileChoiceRowClassName = cn(
    choiceRowClassName,
    // The first column matches the 20px icons of the drawer's action rows, so every label starts on one line.
    "min-h-12 w-full grid-cols-[1.25rem_minmax(0,1fr)_auto_1rem] gap-x-3 px-4 text-left transition-colors hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-inset keyboard-focus:focus-visible:ring-ring/60 motion-reduce:transition-none",
);

function ComputerListChoice({
    activeKey,
    choice,
    onChooseCurrent,
}: {
    readonly activeKey: string;
    readonly choice: ComputerChoice;
    readonly onChooseCurrent: () => void;
}) {
    const current = choice.key === activeKey;
    const content = (
        <ComputerChoiceContent
            choice={choice}
            current={current}
            nameClassName="text-[15px]"
            statusClassName="text-[13px]"
        />
    );
    return current ? (
        <button aria-current="true" className={mobileChoiceRowClassName} onClick={onChooseCurrent} type="button">
            {content}
        </button>
    ) : (
        <a className={mobileChoiceRowClassName} href={choice.href}>
            {content}
        </a>
    );
}

function PendingCurrentComputer({
    className,
    loading,
    name,
}: {
    readonly className: string;
    readonly loading: boolean;
    readonly name: string;
}) {
    return (
        <p className={cn("truncate text-copy-tertiary", className)} role={loading ? "status" : undefined}>
            {loading ? "Checking connections…" : name}
        </p>
    );
}

export function ComputerSwitcher({
    context,
    model,
    name,
    status,
    layout,
    onChooseCurrent = () => undefined,
}: {
    readonly context: ExecutionContext;
    readonly model: ComputerSwitcherModel;
    readonly name: string;
    readonly status: BotConnectionStatus;
    readonly layout: "header" | "list";
    /** Called when the computer the page is already on is chosen from the list layout. */
    readonly onChooseCurrent?: () => void;
}) {
    const state = useStore(model.store);
    const choices = computerSwitcherChoices(state, name, status);
    const activeKey = model.activeKey;
    const listLoading = state.kind === "loading";
    const active = choices.find((choice) => choice.key === activeKey);
    const computerName = name || active?.name || "Computer";
    const detailsLabel = `View execution details for ${computerName}`;
    if (layout === "list") {
        return (
            <ComputerExecutionDetails context={context}>
                {({ openDetails }) => (
                    <nav aria-label="Computers" className="flex w-full min-w-0 flex-col">
                        <p className={mobileComputersSectionTitleClassName}>Computers</p>
                        <button
                            aria-label={detailsLabel}
                            className={mobileDrawerCardRowClassName}
                            onClick={openDetails}
                            type="button"
                        >
                            <MonitorCog aria-hidden="true" className="size-5 shrink-0 text-copy-secondary" />
                            View execution details
                        </button>
                        <div className={cn(mobileDrawerOptionDividerClassName, "border-t-[0.5px] border-black/[0.06]")}>
                            {choices.length === 0 ? (
                                <PendingCurrentComputer
                                    className="px-4 py-3 text-[15px]"
                                    loading={listLoading}
                                    name={computerName}
                                />
                            ) : (
                                choices.map((choice) => (
                                    <ComputerListChoice
                                        activeKey={activeKey}
                                        choice={choice}
                                        key={choice.key}
                                        onChooseCurrent={onChooseCurrent}
                                    />
                                ))
                            )}
                        </div>
                        <a
                            href="/setup"
                            className={cn(mobileDrawerCardRowClassName, "border-t-[0.5px] border-black/[0.06]")}
                        >
                            <Plus aria-hidden="true" className="size-5 shrink-0 text-copy-secondary" />
                            Connect another computer
                        </a>
                    </nav>
                )}
            </ComputerExecutionDetails>
        );
    }
    const statusLabel = connectionLabel(status);
    return (
        <ComputerExecutionDetails context={context}>
            {({ open: detailsOpen, openDetails }) => (
                <DropdownMenu.Root
                    onOpenChange={(open) => {
                        if (open) {
                            void model.refresh();
                        }
                    }}
                >
                    <DropdownMenu.Trigger asChild>
                        <button
                            type="button"
                            aria-describedby="computer-connection-description"
                            aria-label={`Switch computer, ${computerName}, ${statusLabel}`}
                            data-connection-status={status.kind}
                            data-testid={dataTestId.botConnectionStatus}
                            className="group -mr-1 -ml-1.5 flex h-[50px] w-[calc(100%+0.625rem)] min-w-0 items-center gap-2 rounded-[16px] py-1.5 pr-3 pl-0.5 text-left outline-none transition-colors hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3 data-[state=open]:bg-morty-fill-opacity-3 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 motion-reduce:transition-none"
                        >
                            <MortyLogoMark className="ml-2" size={28} />
                            <span className="mr-1.5 flex min-w-0 flex-1 flex-col">
                                <span
                                    className="mb-0.5 truncate font-inter text-14 leading-5 font-semibold tracking-[-0.01em] text-copy-secondary transition-colors duration-150 group-hover:text-foreground motion-reduce:transition-none"
                                    title={computerName}
                                >
                                    {computerName}
                                </span>
                                <span className="-mb-0.5 flex min-w-0 items-center gap-1 text-12 leading-4 text-morty-text-3">
                                    <StatusDot
                                        className="size-1.5"
                                        online={status.kind === "connected"}
                                        pulsing={status.kind === "connecting"}
                                    />
                                    <span className="truncate">{statusLabel}</span>
                                </span>
                            </span>
                            <ChevronDown
                                aria-hidden="true"
                                className="size-3 shrink-0 text-morty-text-3 transition-colors duration-150 group-hover:text-copy-secondary group-focus-visible:text-copy-secondary group-active:text-copy-secondary group-data-[state=open]:text-copy-secondary motion-reduce:transition-none"
                            />
                        </button>
                    </DropdownMenu.Trigger>
                    <span className="sr-only" id="computer-connection-description">
                        {context.indicator.label}
                    </span>
                    <DropdownMenu.Portal>
                        <DropdownMenu.Content
                            align="start"
                            sideOffset={overlayTriggerOffsetPx}
                            onCloseAutoFocus={(event) => {
                                if (detailsOpen) {
                                    event.preventDefault();
                                }
                            }}
                            {...({
                                onOpenAutoFocus: preventOverlayOpenAutoFocus,
                            } satisfies OverlayContentOpenAutoFocus)}
                            className={cn(
                                "z-[180] flex max-h-[min(70dvh,520px)] min-w-[280px] w-[min(calc(100vw-1.5rem),280px)] animate-cloud-enter flex-col overflow-hidden p-1.5 text-sm text-foreground outline-none motion-reduce:animate-none",
                                overlaySurfacePanelClassName,
                                overlaySurfaceRadiusClassName,
                            )}
                            aria-label="Computers"
                        >
                            {/* Details describe the computer shown on the trigger, so they sit right below it. */}
                            <DropdownMenu.Item
                                aria-label={detailsLabel}
                                className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 text-copy-secondary outline-none data-[highlighted]:bg-accent data-[highlighted]:text-foreground"
                                onSelect={openDetails}
                            >
                                <MonitorCog aria-hidden="true" className="size-4 shrink-0" />
                                View execution details
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator className={cn("-mx-1.5 my-1.5", overlayMenuSeparatorClassName)} />
                            <DropdownMenu.Label className="flex shrink-0 items-center justify-between gap-2 px-3 pt-1 pb-1 text-xs font-normal text-morty-text-3">
                                Computers
                                {listLoading ? (
                                    <span className="inline-flex shrink-0" role="status">
                                        <LoaderCircle
                                            aria-hidden="true"
                                            className="size-3.5 animate-spin text-copy-tertiary motion-reduce:animate-none"
                                        />
                                        <span className="sr-only">Checking connections…</span>
                                    </span>
                                ) : null}
                            </DropdownMenu.Label>
                            <ScrollArea className="-mx-1 min-h-0 rounded-none" viewportClassName="max-h-[inherit] p-1">
                                <DropdownMenu.RadioGroup
                                    aria-label="Computers"
                                    className="flex min-h-0 flex-col"
                                    value={activeKey}
                                >
                                    {choices.length === 0 ? (
                                        <PendingCurrentComputer
                                            className="px-3 py-2"
                                            loading={listLoading}
                                            name={computerName}
                                        />
                                    ) : (
                                        choices.map((choice) => (
                                            <ComputerMenuChoice
                                                activeKey={activeKey}
                                                choice={choice}
                                                key={choice.key}
                                            />
                                        ))
                                    )}
                                </DropdownMenu.RadioGroup>
                            </ScrollArea>
                            <DropdownMenu.Separator className={cn("-mx-1.5 my-1.5", overlayMenuSeparatorClassName)} />
                            <DropdownMenu.Item asChild>
                                <a
                                    href="/setup"
                                    className="flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3 outline-none data-[highlighted]:bg-accent"
                                >
                                    <Plus aria-hidden="true" className="size-4" />
                                    Connect another computer
                                </a>
                            </DropdownMenu.Item>
                        </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                </DropdownMenu.Root>
            )}
        </ComputerExecutionDetails>
    );
}

export function OnlineComputerAlternative({ model }: { readonly model: ComputerSwitcherModel }) {
    const { choices } = useStore(model.store);
    const alternative = choices.find((choice) => choice.kind === "other" && choice.status === "online");
    return alternative === undefined ? null : (
        <a className={`mt-2 inline-flex text-xs font-medium ${textLinkClassName}`} href={alternative.href}>
            Switch to {alternative.name}
        </a>
    );
}
