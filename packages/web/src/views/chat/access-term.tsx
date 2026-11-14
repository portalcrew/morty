import { Clock3, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Button } from "../../components/ui/cloud-button.tsx";
import { ScrollArea } from "../../components/ui/scroll-area.tsx";
import { cn } from "../../lib/utils.ts";
import { type AccessExpiryStore, visibleAccessNotice } from "../../view-models/chat/access-expiry-store.ts";
import { formatMoment } from "../../view-models/chat/access-presentation.ts";

/** Matches the conversation pane card: light fill, white border, module shadow. */
const accessNoticeCardClassName =
    "pointer-events-auto relative mt-0 mb-0 w-full min-w-0 max-h-[200px] max-w-full shrink-0 text-12 text-foreground [overflow-wrap:anywhere]";
/** Shadow sits outside the scroller so the module glow is not clipped at 200px. */
const accessNoticeCardShadowClassName = "pointer-events-none absolute inset-0 rounded-[20px] shadow-module";
const accessNoticeCardScrollClassName =
    "relative h-full max-h-[200px] min-h-0 rounded-[20px] border border-white bg-card/90";
/** Title and actions stay put. Only the body, such as the new-device list, scrolls inside the card. */
const accessNoticeCardBodyClassName =
    "pointer-events-auto relative mt-0 mb-0 flex w-full min-w-0 max-h-[200px] max-w-full shrink-0 flex-col rounded-[20px] border border-white bg-card/90 px-3 py-3 text-12 text-foreground [overflow-wrap:anywhere]";
/** Icon lines up with the vertical center of the title's first line (text-13), not a multi-line block. */
const accessNoticeTitleRowClassName = "flex items-start gap-2";
const accessNoticeTitleIconClassName = "mt-[3px] size-3.5 shrink-0";
const accessNoticeIconSpacerClassName = "size-3.5 shrink-0";
const accessNoticeIndentedRowClassName = "flex items-start gap-2";
const accessNoticeTitleClassName = "text-13 font-semibold leading-5 max-sm:truncate";
const accessNoticeDetailClassName = "[font-size:var(--text-12)] leading-4 text-muted-foreground";
export const sidebarAccessNoticeActionClassName = "max-w-full whitespace-normal";
const accessNoticeActionsClassName = "flex flex-wrap items-center gap-1.5 pt-2 pb-1 max-sm:pt-1 max-sm:pb-0";
/** Menu surface is bg-background (#fafafb); fill sits between that and user-message-surface (#e6e8eb). */
const accessTermMenuCardClassName = "flex items-start gap-2 rounded-[16px] bg-[#f1f2f3] px-3 py-2.5";
/** The menu card is already gray, so its placeholders are darker than ones drawn on white. */
const accessTermMenuSkeletonBarClassName = "animate-pulse rounded-full bg-foreground/15 motion-reduce:animate-none";
const accessTermCardSkeletonBarClassName =
    "animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none";
const accessTermIconRowClassName = "flex h-5 shrink-0 items-center";

export function SidebarAccessNoticeCard({
    actions,
    body,
    bodyClassName,
    detail,
    detailClassName,
    icon: Icon,
    label,
    title,
    mobileTitleSuffix,
}: {
    readonly actions: ReactNode;
    readonly body?: ReactNode;
    readonly bodyClassName?: string;
    readonly detail: string;
    readonly detailClassName?: string;
    readonly icon: typeof ShieldCheck;
    readonly label: string;
    readonly title: string;
    readonly mobileTitleSuffix?: string;
}) {
    if (body === undefined) {
        return (
            <section aria-label={label} className={accessNoticeCardClassName} role="status">
                <div aria-hidden="true" className={accessNoticeCardShadowClassName} />
                <ScrollArea
                    className={accessNoticeCardScrollClassName}
                    viewportClassName="h-full max-h-[inherit] px-3 py-3 max-sm:[&>div]:block!"
                >
                    <div className={accessNoticeTitleRowClassName}>
                        <Icon aria-hidden="true" className={accessNoticeTitleIconClassName} />
                        <p className={cn(accessNoticeTitleClassName, "min-w-0 flex-1")}>{title}</p>
                    </div>
                    <div className={cn(accessNoticeIndentedRowClassName, "mt-1")}>
                        <div aria-hidden="true" className={accessNoticeIconSpacerClassName} />
                        <div className="min-w-0 flex-1">
                            <p className={cn(accessNoticeDetailClassName, detailClassName)}>{detail}</p>
                            <div className={accessNoticeActionsClassName}>{actions}</div>
                        </div>
                    </div>
                </ScrollArea>
            </section>
        );
    }

    return (
        <section aria-label={label} className={accessNoticeCardBodyClassName} role="status">
            <div aria-hidden="true" className={accessNoticeCardShadowClassName} />
            <div className={cn(accessNoticeTitleRowClassName, "relative shrink-0")}>
                <Icon aria-hidden="true" className={accessNoticeTitleIconClassName} />
                <p
                    className={cn(
                        accessNoticeTitleClassName,
                        "min-w-0 flex-1",
                        mobileTitleSuffix !== undefined && "max-sm:flex max-sm:items-center max-sm:gap-2",
                    )}
                >
                    {mobileTitleSuffix === undefined ? (
                        title
                    ) : (
                        <>
                            <span className="max-sm:shrink-0 max-sm:whitespace-nowrap">
                                {title}
                                <span className="sm:hidden">:</span>
                            </span>
                            <span
                                className="flex min-w-0 items-center gap-1.5 font-medium text-foreground/80 sm:hidden"
                                title={mobileTitleSuffix}
                            >
                                <MonitorSmartphone aria-hidden="true" className="size-3.5 shrink-0" />
                                <span className="min-w-0 truncate">{mobileTitleSuffix}</span>
                            </span>
                        </>
                    )}
                </p>
            </div>
            <div className={cn("relative mt-2 flex min-h-0 gap-2", bodyClassName)}>
                <div aria-hidden="true" className={cn(accessNoticeIconSpacerClassName, "self-start")} />
                <div className="relative min-h-0 min-w-0 flex-1">{body}</div>
            </div>
            <div className={cn(accessNoticeIndentedRowClassName, "relative mt-1 shrink-0")}>
                <div aria-hidden="true" className={accessNoticeIconSpacerClassName} />
                <div className="min-w-0 flex-1">
                    <p className={cn(accessNoticeDetailClassName, detailClassName)}>{detail}</p>
                    <div className={accessNoticeActionsClassName}>{actions}</div>
                </div>
            </div>
        </section>
    );
}

function JoinedAccessNoticeCard({
    computerName,
    expiresAt,
    onDismiss,
    onOpenDevices,
}: {
    readonly computerName: string;
    readonly expiresAt: string;
    readonly onDismiss: () => void;
    readonly onOpenDevices: () => void;
}) {
    return (
        <SidebarAccessNoticeCard
            actions={
                <>
                    <Button className={sidebarAccessNoticeActionClassName} onClick={onDismiss} size="xs">
                        Got it
                    </Button>
                    <Button
                        className={sidebarAccessNoticeActionClassName}
                        onClick={onOpenDevices}
                        size="xs"
                        variant="outline"
                    >
                        Devices
                    </Button>
                </>
            }
            detail="Only devices you add can use your computer. See them, or disconnect any, in Devices."
            detailClassName="max-sm:hidden"
            icon={ShieldCheck}
            label="This browser's access"
            title={`This browser can use ${computerName || "your computer"} until ${formatMoment(expiresAt)}.`}
        />
    );
}

function EndingAccessNoticeCard({
    expiresAt,
    onDismiss,
}: {
    readonly expiresAt: string;
    readonly onDismiss: () => void;
}) {
    return (
        <SidebarAccessNoticeCard
            actions={
                <Button className={sidebarAccessNoticeActionClassName} onClick={onDismiss} size="xs">
                    Got it
                </Button>
            }
            detail="To keep using Morty here, open a new link from your computer or another device. Your local agent and tasks keep running."
            detailClassName="max-sm:hidden"
            icon={Clock3}
            label="Access ending soon"
            title={`Access in this browser ends ${formatMoment(expiresAt)}`}
        />
    );
}

/**
 * Tells this browser about its access, once each way: when it joined, until when it can use the computer and where
 * every device can be seen and disconnected; and, near the end, how to keep using Morty here.
 * Render in the sidebar drawer immediately above the account and connection actions row.
 */
export function AccessNotice({
    computerName,
    onOpenDevices,
    store,
}: {
    readonly computerName: string;
    /** Opens the devices with access. */
    readonly onOpenDevices: () => void;
    readonly store: StoreApi<AccessExpiryStore>;
}) {
    const { state, dismiss } = useStore(store);
    const shown = visibleAccessNotice(state);
    if (shown === null) {
        return null;
    }
    if (shown.notice === "joined") {
        return (
            <JoinedAccessNoticeCard
                computerName={computerName}
                expiresAt={shown.expiresAt}
                onDismiss={dismiss}
                onOpenDevices={onOpenDevices}
            />
        );
    }
    return <EndingAccessNoticeCard expiresAt={shown.expiresAt} onDismiss={dismiss} />;
}

/**
 * Same footprint as the loaded term: title line, then the "Until …" line. The card does not jump when the date arrives.
 */
function AccessTermSkeleton({ layout }: { readonly layout: "menu" | "card" }) {
    const barClassName = layout === "card" ? accessTermCardSkeletonBarClassName : accessTermMenuSkeletonBarClassName;
    const body = (
        <>
            <span className="sr-only">Loading browser access</span>
            <div aria-hidden="true" className={accessTermIconRowClassName}>
                <div className={cn(layout === "card" ? "size-5" : "size-4", "rounded-full", barClassName)} />
            </div>
            <div aria-hidden="true" className="min-w-0 flex-1">
                <div className="flex h-5 items-center">
                    <div className={cn("h-3.5 w-40", barClassName)} />
                </div>
                <div className="my-0.5 flex h-4 items-center">
                    <div className={cn("h-3 w-32", barClassName)} />
                </div>
            </div>
        </>
    );
    if (layout === "card") {
        return (
            <div
                aria-busy="true"
                aria-label="Loading browser access"
                className="flex min-h-12 items-start gap-3 px-4 py-2"
                role="status"
            >
                {body}
            </div>
        );
    }
    return (
        <DropdownMenu.Label
            aria-busy="true"
            aria-label="Loading browser access"
            className={cn(accessTermMenuCardClassName, "mb-1.5")}
            role="status"
        >
            {body}
        </DropdownMenu.Label>
    );
}

/**
 * This browser's access term as a read-only line: heading the desktop account menu, or a row of the phone's connection
 * actions. Nothing when the access has no term. A skeleton holds the place while the term is still being read.
 */
export function AccessTerm({
    layout,
    store,
}: {
    readonly layout: "menu" | "card";
    readonly store: StoreApi<AccessExpiryStore>;
}) {
    const state = useStore(store, (model) => model.state);
    if (state.kind === "unknown") {
        return <AccessTermSkeleton layout={layout} />;
    }
    if (state.kind !== "known" || state.expiresAt === null) {
        return null;
    }
    const titleClassName =
        layout === "card"
            ? "text-[15px] font-medium leading-5 text-foreground"
            : "font-medium leading-5 text-foreground";
    const term = (
        <div className="min-w-0">
            <p className={titleClassName}>Access in this browser</p>
            <p className="my-0.5 text-xs text-muted-foreground">Until {formatMoment(state.expiresAt)}</p>
        </div>
    );
    const termIconClassName = layout === "card" ? "size-5 text-copy-secondary" : "size-4 text-muted-foreground";
    if (layout === "card") {
        return (
            <div className="flex min-h-12 items-start gap-3 px-4 py-2">
                <div className={accessTermIconRowClassName}>
                    <Clock3 aria-hidden="true" className={termIconClassName} />
                </div>
                {term}
            </div>
        );
    }
    return (
        <DropdownMenu.Label className={cn(accessTermMenuCardClassName, "mb-1.5")}>
            <div className={accessTermIconRowClassName}>
                <Clock3 aria-hidden="true" className={termIconClassName} />
            </div>
            {term}
        </DropdownMenu.Label>
    );
}
