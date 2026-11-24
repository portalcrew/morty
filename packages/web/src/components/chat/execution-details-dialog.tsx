import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { cn } from "@/lib/utils";
import { dataTestId } from "../../data-testid.ts";
import type { ComputerUpdateStoreApi } from "../../view-models/chat/computer-update-store.ts";
import { Button } from "../ui/cloud-button.tsx";
import { executionDetailsDialogDesktopWidthClassName } from "../ui/overlay-surface.ts";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { mobileHeaderIconButtonBelowSmClassName } from "./chat-header-control.ts";
import { ComputerUpdateDetails } from "./computer-update-details.tsx";
import type { ExecutionContext } from "./execution-context.ts";
import { HarnessMark } from "./harness-mark.tsx";
import { mobileSheetSurfaceClassName } from "./mobile-sheet.ts";
import { MobileSheetTitle } from "./mobile-sheet-title.tsx";

function computerStatusDotClassName(status: ExecutionContext["computerStatus"]): string {
    switch (status) {
        case "Online":
            return "size-2 bg-success";
        case "Checking availability":
            return "size-1.5 animate-pulse bg-amber-500 motion-reduce:animate-none";
        case "Offline":
        case "Not paired":
        case "Disconnected for security":
        case "Status unavailable":
            return "size-1.5 bg-muted-foreground/60";
    }
}

const executionDetailsTermClassName = "shrink-0 whitespace-nowrap text-muted-foreground";

function ExecutionDetails({
    context,
    update,
}: {
    readonly context: ExecutionContext;
    readonly update: ComputerUpdateStoreApi;
}) {
    return (
        <dl className="grid gap-4 text-[13px] leading-5">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-4">
                <dt className={executionDetailsTermClassName}>Agent</dt>
                <dd className="min-w-0 font-medium text-foreground">
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                        <HarnessMark className="[&>svg]:size-3.5" harness={context.harness} label={context.agent} />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{context.agent}</span>
                    </span>
                </dd>
                <dt className={executionDetailsTermClassName}>Computer</dt>
                <dd className="text-foreground [overflow-wrap:anywhere]">{context.computer}</dd>
                <dt className={executionDetailsTermClassName}>Session connection</dt>
                <dd className="text-foreground">{context.connection}</dd>
                <dt className={executionDetailsTermClassName}>Computer status</dt>
                <dd className="text-foreground">
                    <span className="inline-flex items-center gap-1.5">
                        <span
                            aria-hidden="true"
                            className={cn("shrink-0 rounded-full", computerStatusDotClassName(context.computerStatus))}
                        />
                        {context.computerStatus}
                    </span>
                    {context.lastConfirmed !== null && (
                        <span className="mt-1 block text-xs text-muted-foreground">{context.lastConfirmed}</span>
                    )}
                </dd>
                <ComputerUpdateDetails online={context.computerStatus === "Online"} update={update} />
            </div>
            <div className="grid gap-2.5">
                <dt className={executionDetailsTermClassName}>Working directory</dt>
                <dd
                    data-testid={dataTestId.executionDirectory}
                    className="select-text rounded-[16px] bg-muted/70 px-3.5 py-3 font-mono text-xs leading-5 text-foreground [overflow-wrap:anywhere]"
                >
                    {context.directory ?? context.directoryPlaceholder}
                </dd>
            </div>
        </dl>
    );
}

export function ExecutionDetailsDialog({
    context,
    update,
    open,
    onOpenChange,
    returnFocus,
}: {
    readonly context: ExecutionContext;
    readonly update: ComputerUpdateStoreApi;
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly returnFocus: () => void;
}) {
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[190] bg-black/30 motion-safe:data-[state=open]:animate-cloud-enter motion-safe:data-[state=closed]:animate-sheet-backdrop-exit" />
                <Dialog.Content
                    className={cn(
                        "fixed inset-x-0 bottom-0 z-[191] flex max-h-[85dvh] flex-col overflow-hidden rounded-t-[28px] pt-0 pb-[max(24px,env(safe-area-inset-bottom))] font-inter text-13 leading-5 text-foreground shadow-lg outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:flex sm:max-h-[calc(100dvh-2rem)] sm:max-w-[calc(100vw-24px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:border sm:border-white sm:bg-card sm:px-6 sm:pt-6 sm:pb-6",
                        "motion-safe:max-sm:data-[state=open]:animate-sheet-enter motion-safe:max-sm:data-[state=closed]:animate-sheet-exit motion-safe:sm:data-[state=open]:animate-cloud-enter",
                        mobileSheetSurfaceClassName,
                        executionDetailsDialogDesktopWidthClassName,
                        "sm:rounded-overlay",
                    )}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        returnFocus();
                    }}
                >
                    {/* The phone sheet keeps the shared 64px title row, so its title sits on the same 20px
                        gutter as the other sheets while the desktop dialog keeps its own header spacing. */}
                    <header className="flex shrink-0 items-center gap-3 max-sm:h-16 max-sm:gap-2 max-sm:pl-5 max-sm:pr-3 sm:mb-5">
                        <div className="min-w-0 flex-1">
                            <Dialog.Title asChild>
                                <MobileSheetTitle>Execution details</MobileSheetTitle>
                            </Dialog.Title>
                            <Dialog.Description className="sr-only">
                                Computer availability, session connection, Agent, Morty version, and working directory.
                            </Dialog.Description>
                        </div>
                        <Dialog.Close asChild>
                            <Button
                                aria-label="Close execution details"
                                className={cn("sm:-mr-1.5", mobileHeaderIconButtonBelowSmClassName)}
                                size="icon"
                                variant="ghost"
                            >
                                <X aria-hidden="true" className="size-4 max-sm:size-5" />
                            </Button>
                        </Dialog.Close>
                    </header>
                    <ScrollArea
                        className="min-h-0 flex-1 sm:-mx-1"
                        viewportClassName="h-full max-h-[inherit] px-6 sm:px-1"
                    >
                        <ExecutionDetails context={context} update={update} />
                    </ScrollArea>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
