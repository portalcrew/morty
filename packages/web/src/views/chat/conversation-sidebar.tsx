import { nativeSessionKey, sameNativeSession } from "@morty-build/client/native-session";
import type { NativeSessionTarget } from "@morty-build/client/protocol";
import {
    ArrowLeftRight,
    Check,
    Laptop,
    List,
    LoaderCircle,
    LogOut,
    type LucideIcon,
    MessageSquare,
    MessageSquarePlus,
    MonitorSmartphone,
    RefreshCw,
    Share2,
    Wifi,
    X,
} from "lucide-react";
import { ContextMenu, Tooltip } from "radix-ui";
import type { MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { MortyLogoMark } from "../../components/brand/morty-logo.tsx";
import { mobileHeaderIconButtonClassName } from "../../components/chat/chat-header-control.ts";
import { ComputerOfflineIcon } from "../../components/chat/computer-offline-icon.tsx";
import {
    mobileSheetHeaderClassName,
    mobileSheetSessionRowClassName,
    mobileSheetSurfaceClassName,
} from "../../components/chat/mobile-sheet.ts";
import { MobileSheetTitle } from "../../components/chat/mobile-sheet-title.tsx";
import { PanelPresence } from "../../components/chat/panel-presence.tsx";
import { SidebarAccessNoticeHost } from "../../components/chat/sidebar-access-notice-host.tsx";
import { panelMotionClassName } from "../../components/chat/sidebar-panel-presence.ts";
import { SidebarUserMenu } from "../../components/chat/sidebar-user-menu.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { MortyTooltipContent } from "../../components/ui/morty-tooltip-content.tsx";
import { type OverlayContentOpenAutoFocus, preventOverlayOpenAutoFocus } from "../../components/ui/overlay-surface.ts";
import { ScrollArea } from "../../components/ui/scroll-area.tsx";
import { DesktopChatLayout } from "../../components/utils/desktop-chat-layout.tsx";
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import { chatDiagnostics } from "../../view-models/chat/chat-diagnostics.ts";
import type { ChatWorkspace } from "../../view-models/chat/chat-workspace.ts";
import { computerLocationLabel } from "../../view-models/chat/computer-location-label.ts";
import type { BotConnectionStatus } from "../../view-models/chat/computer-status-store.ts";
import {
    type ConversationDirectoryStore,
    conversationDirectorySessions,
} from "../../view-models/chat/conversation-directory-store.ts";
import { type ConversationGroup, groupConversationsByUpdatedAt } from "../../view-models/chat/conversation-groups.ts";
import { conversationListStatus, hasUnreadConversation } from "../../view-models/chat/conversation-status-store.ts";
import { pendingExecutionContext, sessionExecutionContext } from "../../view-models/chat/execution-context.ts";
import { nativeSessionAgentTabs } from "../../view-models/chat/native-session-agents.ts";
import { noSessionDelivery } from "../../view-models/chat/session-delivery-store.ts";
import { noSessionExecution } from "../../view-models/chat/session-execution.ts";
import { noSessionPane } from "../../view-models/chat/session-pane-store.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { AccessTerm } from "./access-term.tsx";
import {
    ComputerSwitcher,
    mobileDrawerCardClassName,
    mobileDrawerCardRowClassName,
    mobileDrawerOptionDividerClassName,
} from "./computer-switcher.tsx";
import { IdentitySharing } from "./identity-sharing.tsx";
import { NativeSessionDialog } from "./native-session-dialog.tsx";
import { NewDeviceNotice } from "./new-device-notice.tsx";

/** Hop label in the network latency list. The icon is a round trip between the two names. */
function NetworkHopLabel({ from, to }: { readonly from: string; readonly to: string }) {
    return (
        <span className="inline-flex items-center">
            {from}
            <ArrowLeftRight aria-hidden="true" className="mx-1.5 size-3.5 shrink-0 text-morty-text-4" />
            <span className="sr-only"> ↔ </span>
            {to}
        </span>
    );
}

const networkLatencyCardShellClassName = "relative pb-1 pt-3";
/** Shadow sits outside the clipped surface so the module glow is not cut off by the dialog scroller. */
const networkLatencyCardShadowClassName =
    "pointer-events-none absolute inset-x-0 top-3 bottom-1 rounded-[16px] shadow-module";
const networkLatencyCardSurfaceClassName = "relative overflow-hidden rounded-[16px] border border-white bg-card px-4";
const networkLatencyRowClassName = "flex items-center justify-between gap-4 py-3.5";
const networkLatencyDividerClassName = "border-t border-border/40 -mx-4 px-4";

function NetworkLatencyCard({ children }: { readonly children: ReactNode }) {
    return (
        <div className={networkLatencyCardShellClassName}>
            <div aria-hidden="true" className={networkLatencyCardShadowClassName} />
            <div className={networkLatencyCardSurfaceClassName}>{children}</div>
        </div>
    );
}

function NetworkLatencyIntro({ computerId }: { readonly computerId: string | null }) {
    return (
        <div className="text-14 leading-5 text-muted-foreground">
            <p>Round-trip latency for this browser and its connected Computer.</p>
            <p className="mt-1">Relay location: {computerLocationLabel(computerId ?? "")}</p>
        </div>
    );
}
const networkLatencySkeletonBarClassName = "h-3.5 rounded-full bg-morty-fill-opacity-3";
const networkLatencySkeletonRows = [
    { label: "w-36", value: "w-12" },
    { label: "w-40", value: "w-12" },
    { label: "w-32", value: "w-12" },
    { label: "w-36", value: "w-14" },
] as const;

/** Same four-row footprint as the latency list, so the dialog does not jump when the numbers arrive. */
function NetworkLatencySkeleton() {
    return (
        <div aria-label="Measuring network latency" role="status">
            <NetworkLatencyCard>
                <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
                    {networkLatencySkeletonRows.map((row, index) => (
                        <div
                            key={`${row.label}-${row.value}`}
                            className={cn(networkLatencyRowClassName, index > 0 && networkLatencyDividerClassName)}
                        >
                            <div className="flex h-5 items-center">
                                <div className={cn(networkLatencySkeletonBarClassName, row.label)} />
                            </div>
                            <div className="flex h-5 items-center">
                                <div className={cn(networkLatencySkeletonBarClassName, row.value)} />
                            </div>
                        </div>
                    ))}
                </div>
            </NetworkLatencyCard>
        </div>
    );
}

/** Releases pointer-click focus so the action's tooltip and focus ring do not linger. */
function blurAfterPointerClick(event: MouseEvent<HTMLButtonElement>): void {
    if (event.detail > 0) {
        event.currentTarget.blur();
    }
}

function SidebarSessionOption({
    label,
    icon: Icon,
    onClick,
    testId,
    disabled = false,
    variant = "nav",
}: {
    readonly label: string;
    readonly icon: LucideIcon;
    readonly onClick: () => void;
    readonly testId?: string;
    readonly disabled?: boolean;
    readonly variant?: "nav" | "card";
}) {
    return (
        <button
            type="button"
            className={
                variant === "card"
                    ? mobileDrawerCardRowClassName
                    : "flex w-full items-center gap-2.5 rounded-lg px-3.5 py-2 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 active:bg-morty-fill-opacity-3 active:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-copy-secondary disabled:active:text-copy-secondary motion-reduce:transition-none"
            }
            data-testid={testId}
            disabled={disabled}
            onClick={onClick}
        >
            <Icon
                aria-hidden="true"
                className={variant === "card" ? "size-5 shrink-0 text-copy-secondary" : "size-4 shrink-0"}
            />
            {label}
        </button>
    );
}

function SidebarActionTooltip({
    children,
    label,
    side = "bottom",
}: {
    readonly children: ReactNode;
    readonly label: string;
    readonly side?: "top" | "bottom";
}) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
            <Tooltip.Portal>
                <MortyTooltipContent side={side} sideOffset={6}>
                    {label}
                    <Tooltip.Arrow className="fill-foreground" />
                </MortyTooltipContent>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}

function ManagedSessionDirectoryList({
    directory,
    archive,
    sessions,
    conversationGroups,
    activeTarget,
    showSelectedIndicator = false,
    connectionStatus,
    sessionStatuses,
    openPane,
    onConnectAgent,
    onOpen,
    archiveSession,
    operationsSignal,
}: {
    readonly directory: ConversationDirectoryStore["state"];
    readonly archive: ConversationDirectoryStore["archive"];
    readonly sessions: readonly ManagedChatSession[] | null;
    readonly conversationGroups: readonly ConversationGroup[] | null;
    readonly activeTarget: NativeSessionTarget | null;
    /** The phone sheet has no persistent selection elsewhere, so it marks the open Session with a check. */
    readonly showSelectedIndicator?: boolean;
    readonly connectionStatus: BotConnectionStatus;
    readonly sessionStatuses: Parameters<typeof conversationListStatus>[1];
    /** The open Session's pane, whose turn and delivery decide that Session's status. */
    readonly openPane: Parameters<typeof conversationListStatus>[2];
    readonly onConnectAgent: (() => void) | null;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly archiveSession: ConversationDirectoryStore["archiveSession"];
    readonly operationsSignal: () => AbortSignal;
}) {
    return (
        <Tooltip.Provider delayDuration={150}>
            {(directory.kind === "failed" || directory.kind === "stale") &&
                (directory.failure === "connection" ? (
                    <div
                        role="status"
                        className="flex flex-col items-start gap-2 px-2 py-3 text-xs text-muted-foreground"
                    >
                        <ComputerOfflineIcon />
                        <p>{directory.message}</p>
                    </div>
                ) : (
                    <MortyAlert>{directory.message}</MortyAlert>
                ))}
            {directory.kind === "setup-required" && (
                <div className="flex flex-col items-center rounded-xl border border-border/70 bg-white/55 px-4 py-5 text-center shadow-[0_1px_3px_rgba(17,24,20,0.04)]">
                    <span className="mb-2 flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <MessageSquare aria-hidden="true" className="size-4" />
                    </span>
                    <p className="text-sm font-medium text-foreground">No sessions yet</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Connect your local agent to start chatting.
                    </p>
                    {onConnectAgent !== null && (
                        <Button className="mt-3" onClick={onConnectAgent} size="sm" variant="outline">
                            Connect agent
                        </Button>
                    )}
                </div>
            )}
            {archive.kind === "failed" && <MortyAlert>{archive.message}</MortyAlert>}
            {sessions !== null && sessions.length === 0 && (
                <p className="py-3 text-xs text-muted-foreground sm:py-2 sm:pl-3.5">
                    Your Chat sessions will appear here.
                </p>
            )}
            {conversationGroups?.map((group) => (
                <section className="min-w-0 w-full pb-3 last:pb-0" key={group.label}>
                    <h3 className="sticky top-0 z-[11] -mx-2 mb-0 bg-card px-6 pb-1 pt-1 text-13 font-normal text-morty-text-3 max-sm:[font-size:14px] sm:-mx-2.5 sm:bg-sidebar sm:px-6 sm:text-11">
                        {group.label}
                    </h3>
                    {group.sessions.map((session) => {
                        const status = conversationListStatus(session, sessionStatuses, openPane);
                        const sessionButton = (
                            <button
                                data-testid={dataTestId.managedConversation}
                                type="button"
                                aria-label={`Open ${session.title}`}
                                aria-current={
                                    activeTarget !== null && sameNativeSession(activeTarget, session.target)
                                        ? "page"
                                        : undefined
                                }
                                disabled={connectionStatus.kind !== "connected"}
                                onClick={() => onOpen(session)}
                                className={cn(
                                    "mb-0 grid grid-cols-[minmax(0,1fr)_auto] disabled:opacity-50 aria-[current=page]:bg-morty-fill-opacity-3 aria-[current=page]:text-foreground aria-[current=page]:hover:bg-morty-fill-opacity-4 aria-[current=page]:hover:text-foreground aria-[current=page]:disabled:hover:text-foreground",
                                    mobileSheetSessionRowClassName,
                                )}
                            >
                                <span className="min-w-0 truncate">{session.title}</span>
                                {status.kind === "working" ? (
                                    <span
                                        aria-label="Session working"
                                        className="inline-flex -mr-[3px] size-4 items-center justify-center text-copy-secondary"
                                        data-testid={dataTestId.sessionStatus}
                                        role="status"
                                    >
                                        <LoaderCircle
                                            aria-hidden="true"
                                            className="size-3.5 animate-spin motion-reduce:animate-none"
                                        />
                                    </span>
                                ) : status.kind === "failed" ? (
                                    <span
                                        aria-label="Session failed"
                                        className="text-xs text-destructive"
                                        data-testid={dataTestId.sessionStatus}
                                        role="status"
                                    >
                                        Failed
                                    </span>
                                ) : status.kind === "unread" ? (
                                    <span
                                        aria-label="Unread response"
                                        className="inline-flex -mr-[3px] size-4 items-center justify-center"
                                        data-testid={dataTestId.sessionStatus}
                                        role="status"
                                    >
                                        <span className="size-2 rounded-full bg-primary" />
                                    </span>
                                ) : showSelectedIndicator &&
                                  activeTarget !== null &&
                                  sameNativeSession(activeTarget, session.target) ? (
                                    <span
                                        aria-hidden="true"
                                        className="inline-flex -mr-[3px] size-4 items-center justify-center"
                                    >
                                        <Check className="size-4" />
                                    </span>
                                ) : null}
                            </button>
                        );
                        const sessionTrigger =
                            session.directoryLabel.length > 0 ? (
                                <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                        <ContextMenu.Trigger asChild>{sessionButton}</ContextMenu.Trigger>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                        <MortyTooltipContent className="max-w-xs leading-5" side="right" sideOffset={8}>
                                            <div className="grid gap-1">
                                                <span className="font-medium break-words">{session.title}</span>
                                                <span className="break-all text-background/80">
                                                    {session.directoryLabel}
                                                </span>
                                            </div>
                                            <Tooltip.Arrow className="fill-foreground" />
                                        </MortyTooltipContent>
                                    </Tooltip.Portal>
                                </Tooltip.Root>
                            ) : (
                                <ContextMenu.Trigger asChild>{sessionButton}</ContextMenu.Trigger>
                            );
                        return (
                            <div className="min-w-0 w-full" key={nativeSessionKey(session.target)}>
                                <ContextMenu.Root>
                                    {sessionTrigger}
                                    <ContextMenu.Portal>
                                        <ContextMenu.Content
                                            className="z-[110] min-w-40 rounded-lg border border-border bg-background p-1 text-sm text-foreground shadow-lg"
                                            {...({
                                                onOpenAutoFocus: preventOverlayOpenAutoFocus,
                                            } satisfies OverlayContentOpenAutoFocus)}
                                        >
                                            <ContextMenu.Item
                                                className="cursor-pointer rounded-md px-3 py-2 outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
                                                disabled={archive.kind === "archiving"}
                                                onSelect={() => {
                                                    void archiveSession(session.target, operationsSignal());
                                                }}
                                            >
                                                Close session
                                            </ContextMenu.Item>
                                        </ContextMenu.Content>
                                    </ContextMenu.Portal>
                                </ContextMenu.Root>
                            </div>
                        );
                    })}
                </section>
            ))}
        </Tooltip.Provider>
    );
}

export function ConversationSidebar({
    computerId,
    connectionStatus,
    workspace,
    onConnectAgent,
    activeTarget,
    onOpen,
    onNewConversation,
}: {
    readonly computerId: string;
    readonly connectionStatus: BotConnectionStatus;
    readonly workspace: ChatWorkspace;
    readonly onConnectAgent: (() => void) | null;
    readonly activeTarget: NativeSessionTarget | null;
    readonly onOpen: (session: ManagedChatSession) => void;
    readonly onNewConversation: () => void;
}) {
    // The workspace owns the sidebar's dialog, remote-access, and diagnostic
    // stores outside React; the view only subscribes.
    const dialogs = workspace.sidebar.dialogs;
    const home = useStore(workspace.home);
    const status = useStore(workspace.computer);
    const draftSettings = useStore(workspace.draftControls, (state) => state.settings);
    const openPane = useStore(workspace.pane);
    const pane = openPane.kind === "open" ? openPane.model : null;
    const paneConnection = useStore(pane?.store ?? noSessionPane, (state) => state.connection);
    const paneDelivery = useStore(pane?.delivery ?? noSessionDelivery, (state) => state.state);
    const paneExecution = useStore(pane?.execution ?? noSessionExecution, (state) => state.state);
    const executionContext =
        home.selection.kind === "ready" && pane !== null
            ? sessionExecutionContext(pane.session, home, status, paneConnection)
            : pendingExecutionContext(home, status, draftSettings);
    const computer = status.computerConfiguration?.computer ?? null;
    const computerName = computer?.computerName ?? "";
    const nativeAgents = computer === null ? [] : nativeSessionAgentTabs(computer);
    const directory = useStore(workspace.directory, (state) => state.state);
    const archive = useStore(workspace.directory, (state) => state.archive);
    const titles = useStore(workspace.titles, (state) => state.titles);
    const calendarDay = useStore(workspace.directory, (state) => state.calendarDay);

    const sessionStatuses = useStore(workspace.statuses, (state) => state.observations);
    const dialogState = useStore(dialogs);
    const mobileNavOpen = dialogState.mobilePanel.kind === "nav";
    const mobileSessionsOpen = dialogState.mobilePanel.kind === "sessions";
    const nativeDialog = dialogState.nativeDialog;
    const sharingStore = dialogState.sharing;
    const openMobileRecentSessions = dialogs.getState().openMobileRecentSessions;
    const closeMobileRecentSessions = dialogs.getState().closeMobileRecentSessions;
    const access = useStore(workspace.sidebar.remoteAccess);
    const deviceAccess = workspace.deviceAccess;
    const diagnostic = useStore(workspace.sidebar.networkDiagnostic);
    const sessionDiagnostics = {
        computerId,
        harness: activeTarget?.harness ?? null,
        sessionId: activeTarget?.sessionId ?? null,
        context: () => chatDiagnostics(workspace),
        read: (signal: AbortSignal) => workspace.requests.daemonDiagnostics(signal),
        readNetwork: (signal: AbortSignal) => workspace.requests.networkDiagnostic(signal),
    };
    const measureNetwork = () => {
        void diagnostic.measure(workspace.operationsSignal()).catch(() => undefined);
    };
    const sessions = conversationDirectorySessions(directory, titles);
    const conversationGroups = sessions === null ? null : groupConversationsByUpdatedAt(sessions, calendarDay);
    const refreshing = directory.kind === "refreshing";
    const openSession = (session: ManagedChatSession) => {
        onOpen(session);
        dialogs.getState().closeMobilePanel();
    };
    const sessionListProps = {
        directory,
        archive,
        sessions,
        conversationGroups,
        activeTarget,
        connectionStatus,
        sessionStatuses,
        openPane:
            home.selection.kind === "ready" && pane !== null
                ? {
                      sessionTarget: pane.session.target,
                      connection: paneConnection,
                      execution: paneExecution,
                      delivery: paneDelivery,
                  }
                : null,
        onConnectAgent,
        onOpen: openSession,
        archiveSession: workspace.directory.getState().archiveSession,
        operationsSignal: workspace.operationsSignal,
    };
    const unreadReplies = hasUnreadConversation(sessions, sessionStatuses, sessionListProps.openPane);
    const accessNotices = (
        <SidebarAccessNoticeHost
            attachAccess={workspace.accessExpiry.getState().onAttach}
            attachLinkedDevices={workspace.linkedDevices.getState().onAttach}
        >
            <NewDeviceNotice
                access={{
                    computerName,
                    onOpenDevices: deviceAccess.getState().open,
                    store: workspace.accessExpiry,
                }}
                onReviewDevices={deviceAccess.getState().open}
                store={workspace.linkedDevices}
            />
        </SidebarAccessNoticeHost>
    );
    return (
        <DesktopChatLayout>
            {(desktop) => (
                <PanelPresence open={mobileNavOpen}>
                    {(navigationMotion) => (
                        <PanelPresence open={mobileSessionsOpen}>
                            {(sessionsMotion) => (
                                <>
                                    <aside
                                        id="conversation-sidebar-mobile-panel"
                                        aria-label="Morty navigation"
                                        className="flex min-h-0 w-full shrink-0 flex-col overflow-visible bg-card/90 px-3 pt-0 sm:w-[264px] sm:gap-0 sm:bg-sidebar sm:px-2.5 sm:pt-2 sm:pb-4"
                                    >
                                        <header className="relative flex min-w-0 shrink-0 items-center justify-between gap-4 py-0 max-sm:z-[110] max-sm:grid max-sm:grid-cols-[auto_minmax(0,1fr)_auto] max-sm:bg-card/90 max-sm:py-2 sm:gap-3">
                                            <div
                                                className={cn(
                                                    "relative z-[1] flex w-fit shrink-0 items-center gap-2 sm:w-full sm:pl-1",
                                                    desktop &&
                                                        // The computer switcher bleeds left with a negative margin; this keeps its
                                                        // mark on the same 16px optical gutter the sidebar had before the
                                                        // outer padding tightened to 10px.
                                                        "sm:min-w-0 sm:shrink sm:pl-0.5",
                                                )}
                                            >
                                                <button
                                                    type="button"
                                                    aria-controls="conversation-sidebar-mobile-drawer"
                                                    aria-expanded={mobileNavOpen}
                                                    aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
                                                    className={cn(
                                                        "inline-flex items-center justify-center outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 sm:hidden",
                                                        mobileHeaderIconButtonClassName,
                                                    )}
                                                    onClick={() => {
                                                        if (mobileNavOpen) {
                                                            dialogs.getState().closeMobilePanel();
                                                        } else {
                                                            dialogs.getState().openMobileNav();
                                                            void workspace.computers.refresh();
                                                        }
                                                    }}
                                                >
                                                    <MortyLogoMark size={24} />
                                                </button>
                                                {desktop ? (
                                                    <>
                                                        <h1 className="sr-only">Morty</h1>
                                                        {/* The computer scopes everything in the sidebar, so it heads it. */}
                                                        <ComputerSwitcher
                                                            context={executionContext}
                                                            layout="header"
                                                            model={workspace.computers}
                                                            name={computerName}
                                                            status={connectionStatus}
                                                        />
                                                    </>
                                                ) : (
                                                    <>
                                                        <MortyLogoMark className="hidden sm:block" size={28} />
                                                        <span className="hidden min-w-0 sm:block">
                                                            <h1 className="truncate font-inter text-16 leading-5 font-semibold tracking-[-0.015em] text-foreground/90">
                                                                Morty
                                                            </h1>
                                                        </span>
                                                    </>
                                                )}
                                                <Button
                                                    variant="ghost"
                                                    className={cn(
                                                        mobileHeaderIconButtonClassName,
                                                        "relative sm:hidden",
                                                    )}
                                                    aria-label={
                                                        unreadReplies
                                                            ? "Recent sessions, unread replies"
                                                            : "Recent sessions"
                                                    }
                                                    aria-expanded={mobileSessionsOpen}
                                                    aria-controls="chat-conversations-mobile-sheet"
                                                    onClick={(event) => {
                                                        event.preventDefault();
                                                        event.stopPropagation();
                                                        if (mobileSessionsOpen) {
                                                            closeMobileRecentSessions();
                                                            return;
                                                        }
                                                        openMobileRecentSessions();
                                                    }}
                                                >
                                                    <List aria-hidden="true" className="size-5" />
                                                    {unreadReplies ? (
                                                        <span
                                                            aria-hidden="true"
                                                            className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-white"
                                                            data-testid={dataTestId.mobileRecentSessionsUnread}
                                                        />
                                                    ) : null}
                                                </Button>
                                            </div>
                                            <div
                                                id={dataTestId.mobileSessionTitleSlot}
                                                className="pointer-events-none flex min-w-0 flex-1 items-center justify-center overflow-visible sm:hidden"
                                            />
                                            <div
                                                className={cn(
                                                    "flex min-w-0 shrink items-center justify-end gap-0.5",
                                                    "sm:hidden",
                                                )}
                                            >
                                                <Tooltip.Provider delayDuration={150}>
                                                    {!desktop && (
                                                        <div className="flex items-center gap-2 sm:hidden">
                                                            <SidebarActionTooltip label="New Session">
                                                                <Button
                                                                    aria-label="New Session"
                                                                    className={mobileHeaderIconButtonClassName}
                                                                    data-testid={dataTestId.newConversation}
                                                                    onClick={onNewConversation}
                                                                    size="icon"
                                                                    variant="ghost"
                                                                >
                                                                    <MessageSquarePlus
                                                                        aria-hidden="true"
                                                                        className="size-5"
                                                                    />
                                                                </Button>
                                                            </SidebarActionTooltip>
                                                            <SidebarActionTooltip label="Open Session">
                                                                <Button
                                                                    aria-label="Open Session"
                                                                    className={mobileHeaderIconButtonClassName}
                                                                    onClick={dialogs.getState().openNativeDialog}
                                                                    size="icon"
                                                                    variant="ghost"
                                                                >
                                                                    <Laptop aria-hidden="true" className="size-5" />
                                                                </Button>
                                                            </SidebarActionTooltip>
                                                        </div>
                                                    )}
                                                </Tooltip.Provider>
                                            </div>
                                        </header>
                                        {!desktop ? <div className="relative z-[115] pb-3">{accessNotices}</div> : null}
                                        {navigationMotion.present ? (
                                            <button
                                                type="button"
                                                aria-label="Close navigation"
                                                className={cn(
                                                    "fixed inset-0 z-[130] bg-black/30 sm:hidden",
                                                    navigationMotion.animate && panelMotionClassName,
                                                    navigationMotion.shown ? "opacity-100" : "opacity-0",
                                                )}
                                                onClick={dialogs.getState().closeMobileNav}
                                            />
                                        ) : null}
                                        <div
                                            id="conversation-sidebar-mobile-drawer"
                                            className={cn(
                                                "min-h-0 flex-1 flex-col gap-0",
                                                navigationMotion.present
                                                    ? cn(
                                                          "fixed inset-y-0 left-0 z-[131] flex w-[85vw] max-w-[85vw] border-r border-border/80 bg-sidebar px-3 py-3 shadow-xl sm:static sm:z-auto sm:w-auto sm:max-w-none sm:translate-x-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:shadow-none sm:transition-none",
                                                          navigationMotion.animate &&
                                                              "max-sm:motion-safe:transition-transform max-sm:motion-safe:duration-[280ms] max-sm:motion-safe:ease-[cubic-bezier(0.32,0.72,0,1)]",
                                                          navigationMotion.shown
                                                              ? "max-sm:translate-x-0"
                                                              : "max-sm:-translate-x-full",
                                                      )
                                                    : "hidden sm:flex",
                                            )}
                                            onTransitionEnd={navigationMotion.onTransitionEnd}
                                        >
                                            <div className="flex shrink-0 items-center gap-3 py-4 pl-2 sm:hidden">
                                                <MortyLogoMark size={36} />
                                                <span className="min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold tracking-[-0.015em]">
                                                    Morty
                                                </span>
                                            </div>
                                            {desktop && (
                                                <nav
                                                    aria-label="Session actions"
                                                    className="box-border hidden min-w-0 w-full shrink-0 flex-col gap-0.5 sm:mt-2 sm:mb-3 sm:flex"
                                                >
                                                    <SidebarSessionOption
                                                        icon={MessageSquarePlus}
                                                        label="New Session"
                                                        testId={dataTestId.newConversation}
                                                        onClick={onNewConversation}
                                                    />
                                                    <SidebarSessionOption
                                                        icon={Laptop}
                                                        label="Open Session"
                                                        onClick={dialogs.getState().openNativeDialog}
                                                    />
                                                </nav>
                                            )}
                                            {/* Isolate only the list so sticky labels stay under the session pane shadow. */}
                                            {desktop && (
                                                <div className="hidden min-h-0 flex-1 sm:isolate sm:flex sm:min-h-0 sm:flex-col sm:gap-0">
                                                    <Tooltip.Provider delayDuration={150}>
                                                        <div className="flex min-w-0 items-center justify-between gap-2.5 pl-2.5 sm:mb-0 sm:w-full sm:pl-3.5">
                                                            <h2 className="font-inter text-13 font-semibold tracking-normal text-copy-secondary">
                                                                Recent sessions
                                                            </h2>
                                                            <SidebarActionTooltip
                                                                label={
                                                                    refreshing
                                                                        ? "Refreshing sessions"
                                                                        : "Refresh sessions"
                                                                }
                                                            >
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="size-8! min-h-8! shrink-0 rounded-lg text-morty-text-3 hover:text-foreground"
                                                                    aria-label={
                                                                        refreshing
                                                                            ? "Refreshing sessions"
                                                                            : "Refresh sessions"
                                                                    }
                                                                    aria-busy={refreshing}
                                                                    disabled={refreshing}
                                                                    onClick={(event) => {
                                                                        blurAfterPointerClick(event);
                                                                        workspace.refreshDirectory();
                                                                    }}
                                                                >
                                                                    <RefreshCw
                                                                        className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                                                                    />
                                                                </Button>
                                                            </SidebarActionTooltip>
                                                        </div>
                                                        <ScrollEdgeFade
                                                            id="chat-conversations"
                                                            fadeClassName="right-2"
                                                            fadeFromClassName="from-sidebar"
                                                            fadeToClassName="to-sidebar/0"
                                                            topFadeClassName="top-6 h-6"
                                                            frameClassName="col-span-2 -ml-3 -mr-3 box-border flex min-h-0 min-w-0 w-[calc(100%+24px)] max-w-none flex-1 flex-col max-sm:row-start-2 sm:-ml-2.5 sm:-mr-2.5 sm:w-[calc(100%+20px)]"
                                                            className="min-h-0 flex-1 space-y-0 px-3 sm:px-2.5"
                                                        >
                                                            <ManagedSessionDirectoryList {...sessionListProps} />
                                                        </ScrollEdgeFade>
                                                    </Tooltip.Provider>
                                                </div>
                                            )}
                                            {desktop ? accessNotices : null}
                                            <Tooltip.Provider delayDuration={150} disableHoverableContent>
                                                <ScrollArea
                                                    className="col-span-2 min-h-0 w-full min-w-0 max-sm:flex-1 sm:shrink-0"
                                                    viewportClassName="h-full max-h-[inherit]"
                                                >
                                                    <div className="flex w-full min-w-0 flex-col gap-0 pt-1 sm:mt-auto sm:flex-row sm:items-center sm:justify-between sm:gap-1 sm:pt-3">
                                                        {!desktop ? (
                                                            <div className={mobileDrawerCardClassName}>
                                                                <ComputerSwitcher
                                                                    context={executionContext}
                                                                    layout="list"
                                                                    model={workspace.computers}
                                                                    name={computerName}
                                                                    onChooseCurrent={dialogs.getState().closeMobileNav}
                                                                    status={connectionStatus}
                                                                />
                                                            </div>
                                                        ) : null}
                                                        {!desktop && (
                                                            <nav
                                                                aria-label="Account actions"
                                                                className={cn(
                                                                    mobileDrawerCardClassName,
                                                                    mobileDrawerOptionDividerClassName,
                                                                    "sm:hidden",
                                                                    "mt-4",
                                                                )}
                                                            >
                                                                <SidebarSessionOption
                                                                    icon={Share2}
                                                                    label="Continue on another device"
                                                                    variant="card"
                                                                    onClick={dialogs.getState().openSharing}
                                                                />
                                                                <BugReportButton
                                                                    appearance="card"
                                                                    daemonSource={sessionDiagnostics}
                                                                    dialog={workspace.bugReportDialog}
                                                                />
                                                            </nav>
                                                        )}
                                                        {!desktop && access.state.kind !== "ended" ? (
                                                            <nav
                                                                aria-label="Connection actions"
                                                                className={cn(
                                                                    mobileDrawerCardClassName,
                                                                    mobileDrawerOptionDividerClassName,
                                                                    "mt-4 sm:hidden",
                                                                )}
                                                            >
                                                                <AccessTerm
                                                                    layout="card"
                                                                    store={workspace.accessExpiry}
                                                                />
                                                                <SidebarSessionOption
                                                                    disabled={access.state.kind === "loading"}
                                                                    icon={MonitorSmartphone}
                                                                    label="Devices"
                                                                    variant="card"
                                                                    onClick={deviceAccess.getState().open}
                                                                />
                                                                <SidebarSessionOption
                                                                    disabled={access.state.kind === "loading"}
                                                                    icon={Wifi}
                                                                    label="Network latency"
                                                                    variant="card"
                                                                    onClick={measureNetwork}
                                                                />
                                                                <SidebarSessionOption
                                                                    disabled={
                                                                        access.state.kind === "loading" ||
                                                                        access.state.kind === "ending"
                                                                    }
                                                                    icon={LogOut}
                                                                    label="End current access"
                                                                    variant="card"
                                                                    onClick={() => {
                                                                        void access.requestEnd(
                                                                            workspace.operationsSignal(),
                                                                        );
                                                                    }}
                                                                />
                                                            </nav>
                                                        ) : null}
                                                        {desktop && access.state.kind !== "ended" ? (
                                                            <SidebarUserMenu
                                                                header={
                                                                    <AccessTerm
                                                                        layout="menu"
                                                                        store={workspace.accessExpiry}
                                                                    />
                                                                }
                                                                disabled={access.state.kind === "loading"}
                                                                endAccessDisabled={
                                                                    access.state.kind === "loading" ||
                                                                    access.state.kind === "ending"
                                                                }
                                                                onOpenDevices={deviceAccess.getState().open}
                                                                onEndAccess={() => {
                                                                    void access.requestEnd(
                                                                        workspace.operationsSignal(),
                                                                    );
                                                                }}
                                                                onMeasureNetwork={measureNetwork}
                                                            />
                                                        ) : null}
                                                        {desktop ? (
                                                            <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                                                <SidebarActionTooltip
                                                                    label="Continue on another device"
                                                                    side="top"
                                                                >
                                                                    <Button
                                                                        aria-label="Continue on another device"
                                                                        className="size-8! min-h-8! shrink-0 justify-center rounded-lg px-0"
                                                                        data-testid={dataTestId.shareIdentity}
                                                                        onClick={(event) => {
                                                                            blurAfterPointerClick(event);
                                                                            dialogs.getState().openSharing();
                                                                        }}
                                                                        size="icon"
                                                                        variant="ghost"
                                                                    >
                                                                        <Share2 aria-hidden="true" className="size-4" />
                                                                    </Button>
                                                                </SidebarActionTooltip>
                                                                <BugReportButton
                                                                    appearance="icon"
                                                                    daemonSource={sessionDiagnostics}
                                                                    dialog={workspace.bugReportDialog}
                                                                />
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                </ScrollArea>
                                            </Tooltip.Provider>
                                        </div>
                                        {nativeDialog !== null && (
                                            <NativeSessionDialog
                                                store={nativeDialog.store}
                                                sessions={sessions ?? []}
                                                agents={nativeAgents}
                                                onClose={dialogs.getState().closeNativeDialog}
                                                onOpenDetail={dialogs.getState().openNativeSessionDetail}
                                                onBack={dialogs.getState().backToNativeSessionList}
                                                step={nativeDialog.step}
                                                bugReportDialog={workspace.bugReportDialog}
                                                daemonSource={sessionDiagnostics}
                                            />
                                        )}
                                        {sharingStore !== null && (
                                            <Dialog
                                                size="medium"
                                                title="Continue on another device"
                                                description="Share this computer with a person on another device, or with an AI agent."
                                                onClose={dialogs.getState().closeSharing}
                                            >
                                                <IdentitySharing store={sharingStore} />
                                            </Dialog>
                                        )}
                                        {diagnostic.state.kind !== "closed" && (
                                            <Dialog
                                                title="Network latency"
                                                headerAction={
                                                    <Button
                                                        aria-label="Refresh network latency"
                                                        disabled={diagnostic.state.kind === "measuring"}
                                                        onClick={measureNetwork}
                                                        size="icon"
                                                        title="Refresh network latency"
                                                        variant="ghost"
                                                    >
                                                        <RefreshCw
                                                            aria-hidden="true"
                                                            className={`size-4 ${diagnostic.state.kind === "measuring" ? "animate-spin" : ""}`}
                                                        />
                                                    </Button>
                                                }
                                                onClose={diagnostic.close}
                                            >
                                                <div className="flex flex-col gap-0">
                                                    <NetworkLatencyIntro computerId={workspace.computerId} />
                                                    {diagnostic.state.kind === "measuring" ? (
                                                        <NetworkLatencySkeleton />
                                                    ) : diagnostic.state.kind === "failed" ? (
                                                        <div className="space-y-4">
                                                            <p className="text-destructive" role="alert">
                                                                {diagnostic.state.message}
                                                            </p>
                                                            <Button onClick={measureNetwork} variant="outline">
                                                                Try again
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <NetworkLatencyCard>
                                                            <dl>
                                                                <div className={networkLatencyRowClassName}>
                                                                    <dt>
                                                                        <NetworkHopLabel from="Browser" to="Morty" />
                                                                    </dt>
                                                                    <dd
                                                                        aria-label="Browser to Morty latency"
                                                                        className="font-mono font-medium"
                                                                        role="status"
                                                                    >
                                                                        {diagnostic.state.browserMortyLatencyMs} ms
                                                                    </dd>
                                                                </div>
                                                                <div
                                                                    className={cn(
                                                                        networkLatencyRowClassName,
                                                                        networkLatencyDividerClassName,
                                                                    )}
                                                                >
                                                                    <dt>
                                                                        <NetworkHopLabel from="Morty" to="Computer" />
                                                                    </dt>
                                                                    <dd
                                                                        aria-label="Morty to Computer latency"
                                                                        className="font-mono font-medium"
                                                                        role="status"
                                                                    >
                                                                        {diagnostic.state.computerLatencyMs} ms
                                                                    </dd>
                                                                </div>
                                                            </dl>
                                                        </NetworkLatencyCard>
                                                    )}
                                                </div>
                                            </Dialog>
                                        )}
                                        {(access.state.kind === "loading" ||
                                            access.state.kind === "unavailable" ||
                                            access.state.kind === "confirming-end" ||
                                            access.state.kind === "ending" ||
                                            access.state.kind === "failed") && (
                                            <Dialog
                                                busy={access.state.kind === "loading" || access.state.kind === "ending"}
                                                title="End current access?"
                                                description={
                                                    <>
                                                        <span className="block">
                                                            This browser loses access to your computer. Your computer
                                                            and your other devices keep theirs, and links you already
                                                            shared still work until they expire.
                                                        </span>
                                                        <span className="mt-3 block font-medium text-foreground">
                                                            Your local agent and tasks keep running.
                                                        </span>
                                                    </>
                                                }
                                                testId={dataTestId.endRemoteAccessDialog}
                                                onClose={access.cancel}
                                            >
                                                {access.state.kind === "loading" && (
                                                    <p role="status">Preparing current access…</p>
                                                )}
                                                {(access.state.kind === "failed" ||
                                                    access.state.kind === "unavailable") && (
                                                    <p className="mt-3 text-sm text-destructive" role="alert">
                                                        {access.state.message}
                                                    </p>
                                                )}
                                                <div className="mt-5 flex justify-end gap-2">
                                                    <Button
                                                        disabled={
                                                            access.state.kind === "loading" ||
                                                            access.state.kind === "ending"
                                                        }
                                                        onClick={access.cancel}
                                                        variant="ghost"
                                                    >
                                                        Cancel
                                                    </Button>
                                                    <Button
                                                        disabled={
                                                            access.state.kind === "loading" ||
                                                            access.state.kind === "ending"
                                                        }
                                                        onClick={() => {
                                                            if (access.state.kind === "unavailable") {
                                                                void access.requestEnd(workspace.operationsSignal());
                                                            } else {
                                                                void access.end(workspace.operationsSignal());
                                                            }
                                                        }}
                                                        variant="primary"
                                                    >
                                                        {access.state.kind === "ending"
                                                            ? "Ending…"
                                                            : access.state.kind === "failed" ||
                                                                access.state.kind === "unavailable"
                                                              ? "Try again"
                                                              : "End current access"}
                                                    </Button>
                                                </div>
                                            </Dialog>
                                        )}
                                    </aside>
                                    {sessionsMotion.present && typeof document !== "undefined"
                                        ? createPortal(
                                              <>
                                                  <button
                                                      type="button"
                                                      aria-label="Close recent sessions"
                                                      className={cn(
                                                          "fixed inset-0 z-[120] bg-black/30 sm:hidden",
                                                          sessionsMotion.animate && panelMotionClassName,
                                                          sessionsMotion.shown ? "opacity-100" : "opacity-0",
                                                      )}
                                                      onClick={() => dialogs.getState().dismissMobileRecentSessions()}
                                                  />
                                                  <div
                                                      id="chat-conversations-mobile-sheet"
                                                      data-testid={dataTestId.mobileRecentSessionsSheet}
                                                      role="dialog"
                                                      aria-modal="true"
                                                      aria-labelledby="mobile-recent-sessions-title"
                                                      className={cn(
                                                          "pointer-events-auto fixed inset-x-0 bottom-0 z-[121] flex h-[80dvh] max-h-[80dvh] flex-col rounded-t-[24px] shadow-[0_-8px_32px_rgba(17,24,20,0.12)] sm:hidden",
                                                          mobileSheetSurfaceClassName,
                                                          sessionsMotion.animate && panelMotionClassName,
                                                          sessionsMotion.shown ? "translate-y-0" : "translate-y-full",
                                                      )}
                                                      onTransitionEnd={sessionsMotion.onTransitionEnd}
                                                  >
                                                      {/* Above the sticky group labels (z-11) and scroll edge fades (z-10) so the header buttons' shadows are not clipped by them. */}
                                                      <header className={mobileSheetHeaderClassName}>
                                                          <MobileSheetTitle id="mobile-recent-sessions-title">
                                                              Recent sessions
                                                          </MobileSheetTitle>
                                                          <div className="flex shrink-0 items-center gap-2">
                                                              <Button
                                                                  variant="ghost"
                                                                  size="icon"
                                                                  className={mobileHeaderIconButtonClassName}
                                                                  aria-label={
                                                                      refreshing
                                                                          ? "Refreshing sessions"
                                                                          : "Refresh sessions"
                                                                  }
                                                                  aria-busy={refreshing}
                                                                  disabled={refreshing}
                                                                  title={
                                                                      refreshing
                                                                          ? "Refreshing sessions"
                                                                          : "Refresh sessions"
                                                                  }
                                                                  onClick={(event) => {
                                                                      blurAfterPointerClick(event);
                                                                      workspace.refreshDirectory();
                                                                  }}
                                                              >
                                                                  <RefreshCw
                                                                      aria-hidden="true"
                                                                      className={`size-5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                                                                  />
                                                              </Button>
                                                              <Button
                                                                  variant="ghost"
                                                                  size="icon"
                                                                  className={mobileHeaderIconButtonClassName}
                                                                  aria-label="Close recent sessions"
                                                                  onClick={closeMobileRecentSessions}
                                                              >
                                                                  <X aria-hidden="true" className="size-5" />
                                                              </Button>
                                                          </div>
                                                      </header>
                                                      <ScrollEdgeFade
                                                          id="chat-conversations-mobile"
                                                          fadeClassName="right-2"
                                                          fadeFromClassName="from-card"
                                                          fadeToClassName="to-card/0"
                                                          topFadeClassName="top-[30px] h-6"
                                                          frameClassName="flex min-h-0 flex-1 flex-col"
                                                          className="min-h-0 flex-1 space-y-0 px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
                                                      >
                                                          <ManagedSessionDirectoryList
                                                              {...sessionListProps}
                                                              showSelectedIndicator
                                                          />
                                                      </ScrollEdgeFade>
                                                  </div>
                                              </>,
                                              document.body,
                                          )
                                        : null}
                                </>
                            )}
                        </PanelPresence>
                    )}
                </PanelPresence>
            )}
        </DesktopChatLayout>
    );
}
