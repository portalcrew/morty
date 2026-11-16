import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { type ReactNode, useRef, useState } from "react";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import { mobileHeaderIconButtonBelowSmClassName } from "../chat/chat-header-control.ts";
import {
    mobileSheetCloseButtonPositionClassName,
    mobileSheetSurfaceClassName,
    mobileSheetTitleRowClassName,
} from "../chat/mobile-sheet.ts";
import { MobileSheetTitle } from "../chat/mobile-sheet-title.tsx";
import { useDialogBodyClippedEdges } from "../utils/use-dialog-body-clipped-edges.ts";
import { Button } from "./cloud-button.tsx";
import { overlaySurfacePanelClassName, overlaySurfaceRadiusClassName } from "./overlay-surface.ts";
import {
    centeredOverlayHorizontalInsetClassName,
    dialogDesktopMaxWidthClassName,
    sheetDialogDesktopMaxWidthClassName,
} from "./overlay-width.ts";
import { ScrollArea } from "./scroll-area.tsx";

export const dialogBodyStackClassName = "flex flex-col gap-5";

export const dialogSectionTitleClassName = "text-[13px] font-medium leading-5 text-foreground";

export const dialogPinnedFooterActionsClassName = "flex justify-end gap-2 px-6 pt-5 pb-6";

function DialogShell({
    onClose,
    busy,
    className,
    testId,
    children,
}: {
    readonly onClose: () => void;
    readonly busy: boolean;
    readonly className: string;
    readonly testId?: string | undefined;
    readonly children: ReactNode;
}) {
    const [returnFocus] = useState(() =>
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
    );
    return (
        <Primitive.Root
            open
            onOpenChange={(open) => {
                if (!open && !busy) {
                    onClose();
                }
            }}
        >
            <Primitive.Portal>
                <Primitive.Overlay className="fixed inset-0 z-50 bg-black/30 motion-safe:animate-cloud-enter" />
                <Primitive.Content
                    data-testid={testId}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        returnFocus?.focus();
                    }}
                    className={className}
                >
                    {children}
                </Primitive.Content>
            </Primitive.Portal>
        </Primitive.Root>
    );
}

function CloseButton({
    busy,
    className,
    iconClassName,
}: {
    readonly busy: boolean;
    readonly className: string;
    readonly iconClassName: string;
}) {
    return (
        <Primitive.Close asChild>
            <Button
                disabled={busy}
                variant="ghost"
                size="icon"
                aria-label="Close dialog"
                data-testid={dataTestId.closeDialog}
                className={className}
            >
                <X aria-hidden="true" className={iconClassName} />
            </Button>
        </Primitive.Close>
    );
}

export function Dialog({
    title,
    description,
    onClose,
    busy = false,
    size = "standard",
    testId,
    headerAction,
    footer,
    children,
}: {
    readonly title: string;
    readonly description?: ReactNode;
    readonly onClose: () => void;
    readonly busy?: boolean;
    readonly size?: "standard" | "medium";
    readonly testId?: string;
    readonly headerAction?: ReactNode;
    readonly footer?: ReactNode;
    readonly children: ReactNode;
}) {
    const bodyScrollRef = useRef<HTMLDivElement>(null);
    const { bodyEdges, syncBodyEdges } = useDialogBodyClippedEdges(bodyScrollRef);
    return (
        <DialogShell
            busy={busy}
            className={`fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] flex-col ${centeredOverlayHorizontalInsetClassName} ${dialogDesktopMaxWidthClassName[size]} -translate-x-1/2 -translate-y-1/2 overflow-hidden ${overlaySurfaceRadiusClassName} border-[1px] border-white bg-card text-[13px] leading-5 text-foreground shadow-lg outline-none motion-safe:animate-cloud-enter`}
            onClose={onClose}
            testId={testId}
        >
            <header className="shrink-0 px-6 pt-6 pb-5">
                <div className={cn("relative flex items-center", headerAction === undefined ? "pr-11" : "pr-24")}>
                    <Primitive.Title className="text-16 font-semibold tracking-tight">{title}</Primitive.Title>
                    {headerAction !== undefined ? (
                        <div className="absolute -right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                            {headerAction}
                            <CloseButton busy={busy} className="" iconClassName="size-4" />
                        </div>
                    ) : (
                        <CloseButton
                            busy={busy}
                            className="absolute -right-1.5 top-1/2 -translate-y-1/2"
                            iconClassName="size-4"
                        />
                    )}
                </div>
                {description ? (
                    <Primitive.Description className="mt-1.5 text-14 leading-5 text-muted-foreground">
                        {description}
                    </Primitive.Description>
                ) : null}
            </header>
            {/* In flow so a short body sets the dialog height. min-h-0 lets this region shrink and scroll once the dialog hits its max height. Absolute fill collapsed the body to 0 because the dialog height is indefinite. */}
            <div className="relative flex min-h-0 flex-col">
                <div
                    ref={bodyScrollRef}
                    onScroll={syncBodyEdges}
                    className={cn(
                        "min-h-0 overflow-y-auto overscroll-contain px-6 [scrollbar-color:#d4d7db_transparent] [scrollbar-width:thin]",
                        footer === undefined && "pb-6",
                    )}
                >
                    {children}
                </div>
                <div
                    aria-hidden="true"
                    className={cn(
                        "pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-card to-card/0 transition-opacity duration-150 motion-reduce:transition-none",
                        bodyEdges.top ? "opacity-100" : "opacity-0",
                    )}
                />
                <div
                    aria-hidden="true"
                    className={cn(
                        "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-card to-card/0 transition-opacity duration-150 motion-reduce:transition-none",
                        bodyEdges.bottom ? "opacity-100" : "opacity-0",
                    )}
                />
            </div>
            {footer !== undefined ? <div className="shrink-0">{footer}</div> : null}
        </DialogShell>
    );
}

export function SheetDialog({
    title,
    onClose,
    busy = false,
    children,
}: {
    readonly title: string;
    readonly onClose: () => void;
    readonly busy?: boolean;
    readonly children: (title: ReactNode) => ReactNode;
}) {
    const header = (
        <header className="mb-0 pr-10 sm:pr-0">
            <Primitive.Title asChild>
                {/* The sm breakpoint is no longer a sheet, so it keeps the centered dialog's tighter tracking. */}
                <MobileSheetTitle className={cn(mobileSheetTitleRowClassName, "sm:tracking-[-0.015em]")}>
                    {title}
                </MobileSheetTitle>
            </Primitive.Title>
        </header>
    );
    return (
        <DialogShell
            busy={busy}
            className={cn(
                "fixed inset-x-0 bottom-0 z-50 flex h-[85dvh] max-h-[calc(100dvh-0.75rem)] w-full flex-col overflow-hidden rounded-t-overlay font-inter text-13 text-foreground outline-none motion-safe:animate-cloud-enter max-sm:[font-size:15px] max-sm:leading-[24px] sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:block sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-overlay",
                sheetDialogDesktopMaxWidthClassName,
                overlaySurfacePanelClassName,
                mobileSheetSurfaceClassName,
            )}
            onClose={onClose}
        >
            <ScrollArea
                className="min-h-0 max-h-[calc(100dvh-2rem)] max-sm:flex-1"
                viewportClassName="max-h-[inherit] max-sm:h-full pt-0 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-2"
            >
                {children(header)}
            </ScrollArea>
            <CloseButton
                busy={busy}
                className={`absolute top-3 right-2 text-morty-text-3 hover:bg-morty-fill-opacity-2 hover:text-foreground sm:top-5 sm:right-5 sm:size-9 ${mobileHeaderIconButtonBelowSmClassName} ${mobileSheetCloseButtonPositionClassName}`}
                iconClassName="size-4 max-sm:size-5"
            />
        </DialogShell>
    );
}
