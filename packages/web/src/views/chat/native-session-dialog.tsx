import { ChevronLeft, CircleAlert, Inbox, MessageSquare, PackageOpen, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import { mobileHeaderIconButtonClassName } from "../../components/chat/chat-header-control.ts";
import { mobileSheetSessionRowClassName } from "../../components/chat/mobile-sheet.ts";
import { MobileSheetTitle } from "../../components/chat/mobile-sheet-title.tsx";
import { NativeSessionDirectoryPlaceholder } from "../../components/chat/native-session-directory-placeholder.tsx";
import {
    SessionAgentTabs,
    sessionAgentTabInactiveLayoutClassName,
    sessionAgentTabSelectedLayoutClassName,
    sessionAgentTabsListClassName,
} from "../../components/chat/session-agent-tabs.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { SheetDialog } from "../../components/ui/dialog.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { DaemonDiagnosticsSource } from "../../services/diagnostics/browser-diagnostics.ts";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import type { NativeSessionAgent } from "../../view-models/chat/native-session-agents.ts";
import { type NativeSessionStore, nativeSessionPresentation } from "../../view-models/chat/native-session-store.ts";
import { useExternalStore } from "../../view-models/external-store.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { MortySessionMessage } from "./morty-session-message.tsx";

/** Touch-sized on the phone sheet, back to the dialog's compact height and type from the sm breakpoint up. */
const sheetControlHeightClassName = "min-h-11 max-sm:[font-size:15px] sm:min-h-9";

/** The preview card; the phone sheet shows it as the second step of the drill-down, desktop always. */
const nativeSessionPreviewCardClassName =
    "min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-white bg-card shadow-module";

/** Desktop insets for the in-card title bar; the phone sheet renders its header above the card. */
const nativeSessionPreviewTitleBarClassName =
    "flex min-h-11 min-w-0 shrink-0 items-center font-inter text-14 font-semibold tracking-[-0.015em] sm:mt-[11px] sm:h-9 sm:min-h-9 sm:pr-[59px] sm:pl-6";

function NativeSessionDirectoryDiscovering() {
    return (
        <div role="status" aria-label="Discovering native sessions" className="min-h-0 flex-1">
            <span className="sr-only">Discovering native sessions</span>
            <NativeSessionDirectoryListSkeleton />
        </div>
    );
}

/** Stands in for saved sessions using the same row boxes the real lists occupy. */
const SESSION_ROW_SKELETON_WIDTHS = ["w-3/4", "w-2/3", "w-4/5", "w-1/2"] as const;

function NativeSessionDirectoryListSkeleton() {
    return (
        <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
            {/* Phone rows: 40px tall in the 8px list gutter, without the desktop card or gaps between rows. */}
            <div className="pr-1 pb-1 sm:hidden">
                {SESSION_ROW_SKELETON_WIDTHS.map((width) => (
                    <div className="flex h-10 items-center px-4" key={width}>
                        <div className={cn("h-3.5 rounded-full bg-morty-fill-opacity-3", width)} />
                    </div>
                ))}
            </div>
            {/* Desktop rows: the same 36px height and 16px/12px gutters as the ready list. */}
            <div className="hidden pb-2 pr-3 sm:block">
                {SESSION_ROW_SKELETON_WIDTHS.map((width) => (
                    <div className="flex h-9 items-center pr-3 pl-4" key={width}>
                        <div className={cn("h-3.5 rounded-full bg-morty-fill-opacity-3", width)} />
                    </div>
                ))}
            </div>
        </div>
    );
}

function NativeSessionAgentTabsSkeleton() {
    return (
        <div aria-hidden="true" className="sm:ml-0.5 sm:mr-2.5">
            <div className={cn(sessionAgentTabsListClassName, "animate-pulse motion-reduce:animate-none")}>
                {/* The first tab is selected, so it takes the remaining width instead of an icon-only slot. */}
                <div
                    className={cn(sessionAgentTabSelectedLayoutClassName, "gap-1.5 border border-transparent bg-card")}
                >
                    <div className="size-4 shrink-0 rounded-sm bg-morty-fill-opacity-3 max-sm:size-5" />
                    <div className="h-3 min-w-0 flex-1 rounded-full bg-morty-fill-opacity-3" />
                </div>
                <div className={sessionAgentTabInactiveLayoutClassName}>
                    <div className="size-4 rounded-sm bg-morty-fill-opacity-3 max-sm:size-5" />
                </div>
                <div className={sessionAgentTabInactiveLayoutClassName}>
                    <div className="size-4 rounded-sm bg-morty-fill-opacity-3 max-sm:size-5" />
                </div>
            </div>
        </div>
    );
}

function NativeSessionFooterSkeleton() {
    return (
        <div aria-hidden="true" className="flex w-full animate-pulse justify-end gap-2 motion-reduce:animate-none">
            {/* Render the real buttons as inert blocks so the placeholder keeps their exact box. */}
            {["Open", "Fork"].map((label) => (
                <Button
                    className={cn(
                        "border-transparent bg-morty-fill-opacity-3 disabled:opacity-100",
                        sheetControlHeightClassName,
                    )}
                    disabled
                    key={label}
                >
                    <span className="invisible">{label}</span>
                </Button>
            ))}
        </div>
    );
}

function NativeSessionLoadMore({
    busy,
    disabled,
    onMore,
}: {
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly onMore: () => void;
}) {
    return (
        <div className="flex justify-center py-2">
            {busy ? (
                <Spinner label="Loading more sessions" />
            ) : (
                <Button className={sheetControlHeightClassName} disabled={disabled} onClick={onMore} variant="ghost">
                    Load more
                </Button>
            )}
        </div>
    );
}

function NativeSessionDialogDiscoveringSkeleton({ title }: { readonly title: ReactNode }) {
    return (
        <div role="status" aria-label="Discovering native sessions" className="contents">
            <span className="sr-only">Discovering native sessions</span>
            <div className="grid min-h-0 min-w-0 grid-cols-1 flex-1 grid-rows-[minmax(0,1fr)] sm:h-[min(72dvh,40rem)] sm:grid-cols-[minmax(15rem,16.5rem)_minmax(0,1fr)] sm:grid-rows-1">
                <div className="flex min-h-0 min-w-0 shrink-0 flex-col gap-1 px-0 sm:px-3">
                    <div className="max-sm:px-5">{title}</div>
                    <section
                        aria-label="Native sessions"
                        className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 max-sm:px-2 sm:-mx-2.5"
                    >
                        <NativeSessionAgentTabsSkeleton />
                        <NativeSessionDirectoryListSkeleton />
                    </section>
                </div>
                <div className={cn(nativeSessionPreviewCardClassName, "hidden sm:flex sm:flex-none")}>
                    <section
                        aria-label="Selected session preview"
                        className="flex min-h-0 min-w-0 flex-1 flex-col"
                        aria-busy="true"
                    >
                        <div aria-hidden="true" className={nativeSessionPreviewTitleBarClassName}>
                            <div className="h-3.5 w-2/5 max-w-full animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none" />
                        </div>
                        <div className="min-h-0 flex-1 p-4 sm:px-6 sm:py-5">
                            <NativeSessionPreviewSkeletonContent />
                        </div>
                    </section>
                    <footer className="flex shrink-0 px-4 py-3 sm:px-5">
                        <NativeSessionFooterSkeleton />
                    </footer>
                </div>
            </div>
        </div>
    );
}

function NativeSessionPreviewSkeletonContent() {
    return (
        <div aria-hidden="true" className="grid animate-pulse gap-8 motion-reduce:animate-none">
            <div className="h-5 w-2/5 rounded-full bg-morty-fill-opacity-3" />
            <div className="ml-auto grid w-full max-w-[68%] justify-items-end gap-2">
                <div className="h-4 w-2/3 rounded-full bg-morty-fill-opacity-3" />
                <div className="h-4 w-full rounded-full bg-morty-fill-opacity-2" />
                <div className="h-4 w-4/5 rounded-full bg-morty-fill-opacity-3" />
            </div>
            <div className="grid w-full max-w-[78%] gap-2">
                <div className="h-4 w-1/3 rounded-full bg-morty-fill-opacity-3" />
                <div className="h-4 w-full rounded-full bg-morty-fill-opacity-2" />
                <div className="h-4 w-5/6 rounded-full bg-morty-fill-opacity-3" />
                <div className="h-4 w-3/5 rounded-full bg-morty-fill-opacity-2" />
            </div>
        </div>
    );
}

function NativeSessionPreviewSkeleton() {
    return (
        <div role="status" aria-label="Loading session preview">
            <span className="sr-only">Loading session preview</span>
            <NativeSessionPreviewSkeletonContent />
        </div>
    );
}

export function NativeSessionDialog({
    store,
    sessions,
    agents,
    onClose,
    onOpenDetail,
    onBack,
    step,
    bugReportDialog,
    daemonSource,
}: {
    /** Created by the owner when the dialog opens; it starts discovery itself. */
    readonly store: StoreApi<NativeSessionStore>;
    readonly sessions: readonly ManagedChatSession[];
    /** The agent tabs, as the Computer configuration the page follows offers them. */
    readonly agents: readonly NativeSessionAgent[];
    readonly onClose: () => void;
    /** The phone sheet drills into the previewed session's detail. */
    readonly onOpenDetail: () => void;
    /** The phone sheet returns from the detail to the session list. */
    readonly onBack: () => void;
    /** The phone sheet's drill-down step; desktop shows both steps at once. */
    readonly step: "list" | "detail";
    readonly bugReportDialog: BugReportDialogStore;
    readonly daemonSource: DaemonDiagnosticsSource;
}) {
    const model = nativeSessionPresentation(useExternalStore(store), sessions);
    const diagnostics: DaemonDiagnosticsSource = {
        ...daemonSource,
        harness: model.directory.kind === "ready" ? model.directory.harness : null,
        sessionId: model.preview.kind === "empty" ? null : model.preview.entry.sessionId,
    };
    const reportButton = <BugReportButton appearance="icon" daemonSource={diagnostics} dialog={bugReportDialog} />;
    const withSignal = (action: (signal: AbortSignal) => Promise<void>) => {
        void action(store.getState().lifetimeSignal());
    };
    const fallback = agents[0];
    const closeDialog = () => {
        onClose();
    };
    return (
        <SheetDialog
            title="Open Session"
            onClose={closeDialog}
            busy={model.operation === "import" || model.operation === "fork"}
        >
            {(title) => (
                <>
                    {model.directory.kind === "loading" && model.directory.scope === "initial" ? (
                        <NativeSessionDialogDiscoveringSkeleton title={title} />
                    ) : (
                        <div className="grid min-h-0 min-w-0 grid-cols-1 flex-1 grid-rows-[minmax(0,1fr)] sm:h-[min(72dvh,40rem)] sm:grid-cols-[minmax(15rem,16.5rem)_minmax(0,1fr)] sm:grid-rows-1">
                            <div
                                className={cn(
                                    "min-h-0 min-w-0 flex-col gap-1 px-0 sm:px-3",
                                    step === "list" ? "flex" : "hidden sm:flex",
                                )}
                            >
                                {/* The sheet keeps the title in its own 20px gutter and lets the list use 8px, matching Recent sessions. */}
                                <div className="max-sm:px-5">{title}</div>
                                <section
                                    aria-label="Native sessions"
                                    className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 max-sm:px-2 sm:-mx-2.5"
                                >
                                    {agents.length > 0 && (
                                        <SessionAgentTabs
                                            agents={agents}
                                            className="sm:ml-0.5 sm:mr-2.5"
                                            dimInactive={
                                                !(
                                                    model.directory.kind === "loading" &&
                                                    model.directory.scope === "refresh"
                                                )
                                            }
                                            disabled={model.operation !== "idle"}
                                            onValueChange={store.getState().selectAgent}
                                            value={model.selected || fallback?.harness || ""}
                                        />
                                    )}
                                    {model.directory.kind === "loading" && model.directory.scope === "refresh" && (
                                        <NativeSessionDirectoryDiscovering />
                                    )}
                                    {model.directory.kind === "empty" && (
                                        <NativeSessionDirectoryPlaceholder
                                            icon={Unplug}
                                            title="No local agent"
                                            description="Connect a computer to browse saved sessions."
                                        />
                                    )}
                                    {model.directory.kind === "agent-unavailable" && (
                                        <NativeSessionDirectoryPlaceholder
                                            icon={PackageOpen}
                                            title={`${model.directory.agentLabel} is not installed`}
                                            description="Install it on this computer to browse saved sessions."
                                        />
                                    )}
                                    {model.directory.kind === "failed" && (
                                        <NativeSessionDirectoryPlaceholder
                                            icon={CircleAlert}
                                            title="Couldn't load sessions"
                                            description={
                                                <span className="inline-flex items-start gap-2 text-left">
                                                    <span className="min-w-0 break-words">
                                                        {model.directory.message}
                                                    </span>
                                                    {reportButton}
                                                </span>
                                            }
                                            tone="destructive"
                                        />
                                    )}
                                    {model.directory.kind === "ready" && model.directory.entries.length === 0 && (
                                        <NativeSessionDirectoryPlaceholder
                                            icon={Inbox}
                                            title="No saved sessions"
                                            description="This agent didn't report any on this computer."
                                        />
                                    )}
                                    {model.directory.kind === "ready" && model.directory.entries.length > 0 && (
                                        <div className="flex min-h-0 flex-1 flex-col sm:hidden">
                                            <ScrollEdgeFade
                                                revealSurface
                                                frameClassName="flex min-h-0 flex-1 flex-col"
                                                className={cn(
                                                    // The 40px rows are already the touch target; extra vertical gaps only make the list longer.
                                                    "min-h-0 flex-1 space-y-0 pr-1 pb-1",
                                                )}
                                            >
                                                {model.directory.entries.map((entry) => (
                                                    <button
                                                        type="button"
                                                        key={entry.sessionId}
                                                        aria-label={`${entry.displayTitle} ${entry.directoryLabel}`}
                                                        aria-pressed={
                                                            model.preview.kind !== "empty" &&
                                                            model.preview.entry.sessionId === entry.sessionId
                                                        }
                                                        disabled={model.operation !== "idle"}
                                                        onClick={() => {
                                                            onOpenDetail();
                                                            withSignal(
                                                                async (signal) =>
                                                                    await store.getState().select(entry, signal),
                                                            );
                                                        }}
                                                        className={cn(
                                                            "group flex aria-pressed:bg-morty-fill-opacity-3 aria-pressed:text-foreground aria-pressed:hover:bg-morty-fill-opacity-4",
                                                            mobileSheetSessionRowClassName,
                                                        )}
                                                    >
                                                        <span className="w-full min-w-0 truncate font-medium text-copy-secondary group-aria-pressed:text-foreground">
                                                            {entry.displayTitle}
                                                        </span>
                                                    </button>
                                                ))}
                                                {model.directory.nextCursor !== null && (
                                                    <NativeSessionLoadMore
                                                        busy={model.operation === "more"}
                                                        disabled={model.operation !== "idle"}
                                                        onMore={() => withSignal(store.getState().more)}
                                                    />
                                                )}
                                            </ScrollEdgeFade>
                                        </div>
                                    )}
                                    {model.directory.kind === "ready" && model.directory.entries.length > 0 && (
                                        <ScrollEdgeFade
                                            revealSurface
                                            edgeStroke={{
                                                className: "border-surface-dialog-composite",
                                                placement: "outside",
                                            }}
                                            frameClassName="hidden min-h-0 flex-1 sm:flex sm:flex-col"
                                            className={cn("min-h-0 flex-1 space-y-0 pr-3 pb-2")}
                                        >
                                            {model.directory.entries.map((entry) => (
                                                <button
                                                    type="button"
                                                    key={entry.sessionId}
                                                    data-testid={dataTestId.localSessionEntry}
                                                    aria-label={entry.displayTitle}
                                                    aria-pressed={
                                                        model.preview.kind !== "empty" &&
                                                        model.preview.entry.sessionId === entry.sessionId
                                                    }
                                                    disabled={model.operation !== "idle"}
                                                    onClick={() =>
                                                        withSignal(
                                                            async (signal) =>
                                                                await store.getState().select(entry, signal),
                                                        )
                                                    }
                                                    className="box-border mb-0 grid h-9 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[20px] pl-4 pr-3 text-left text-[13px] font-medium text-copy-secondary outline-none transition-[background-color,color] duration-150 hover:bg-morty-fill-opacity-2 hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:text-copy-secondary disabled:hover:bg-transparent disabled:hover:text-copy-secondary aria-pressed:bg-morty-fill-opacity-3 aria-pressed:text-foreground aria-pressed:hover:bg-morty-fill-opacity-4 aria-pressed:hover:text-foreground aria-pressed:disabled:hover:text-foreground disabled:aria-pressed:text-foreground motion-reduce:transition-none"
                                                >
                                                    <span className="min-w-0 truncate">{entry.displayTitle}</span>
                                                </button>
                                            ))}
                                            {model.directory.nextCursor !== null && (
                                                <NativeSessionLoadMore
                                                    busy={model.operation === "more"}
                                                    disabled={model.operation !== "idle"}
                                                    onMore={() => withSignal(store.getState().more)}
                                                />
                                            )}
                                        </ScrollEdgeFade>
                                    )}
                                </section>
                            </div>
                            <div
                                className={cn(
                                    "min-h-0 min-w-0 flex-1 flex-col gap-2 px-0 sm:px-0",
                                    step === "detail" ? "flex" : "hidden sm:flex",
                                )}
                            >
                                {/*
                                 * The phone sheet renders this header only on its detail step; desktop hides it.
                                 * Both gutters are 12px like the actions' distance from the top edge of the 64px row,
                                 * and the right padding clears the 40px close action floating 12px from the sheet edge.
                                 * The title keeps at least 16px from either action: the gap holds 16px after the back
                                 * button, and the right padding is 12px edge + 40px close action + 16px gap.
                                 */}
                                {step === "detail" && (
                                    <div className="flex h-16 shrink-0 items-center gap-4 pr-[68px] pl-3 sm:hidden">
                                        <button
                                            type="button"
                                            aria-label="Back to session list"
                                            onClick={onBack}
                                            className={cn(
                                                mobileHeaderIconButtonClassName,
                                                "flex shrink-0 items-center justify-center",
                                            )}
                                        >
                                            <ChevronLeft aria-hidden="true" className="size-5" />
                                        </button>
                                        {(model.preview.kind === "ready" || model.preview.kind === "failed") && (
                                            <MobileSheetTitle
                                                className="min-w-0 flex-1 truncate"
                                                title={model.preview.entry.displayTitle}
                                            >
                                                {model.preview.entry.displayTitle}
                                            </MobileSheetTitle>
                                        )}
                                        {model.preview.kind === "loading" && (
                                            <div
                                                aria-hidden="true"
                                                className="h-3.5 w-2/5 min-w-0 animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none"
                                            />
                                        )}
                                    </div>
                                )}
                                <div
                                    className={cn(nativeSessionPreviewCardClassName, "flex min-h-0 flex-1 max-sm:mx-2")}
                                >
                                    <section
                                        aria-label="Selected session preview"
                                        className="flex min-h-0 min-w-0 flex-1 flex-col"
                                    >
                                        {model.preview.kind === "ready" && (
                                            <h2
                                                className={cn(nativeSessionPreviewTitleBarClassName, "hidden sm:flex")}
                                                title={model.preview.entry.displayTitle}
                                            >
                                                <span className="min-w-0 truncate">
                                                    {model.preview.entry.displayTitle}
                                                </span>
                                            </h2>
                                        )}
                                        {model.preview.kind === "loading" && (
                                            <div
                                                aria-hidden="true"
                                                className={cn(nativeSessionPreviewTitleBarClassName, "hidden sm:flex")}
                                            >
                                                <div className="h-3.5 w-2/5 max-w-full animate-pulse rounded-full bg-morty-fill-opacity-3 motion-reduce:animate-none" />
                                            </div>
                                        )}
                                        {model.preview.kind === "empty" && (
                                            <div
                                                aria-hidden="true"
                                                className={cn(nativeSessionPreviewTitleBarClassName, "hidden sm:flex")}
                                            />
                                        )}
                                        <ScrollEdgeFade
                                            revealSurface
                                            edgeStroke={{ className: "border-card", placement: "outside" }}
                                            frameClassName="flex min-h-0 flex-1 flex-col"
                                            className={cn(
                                                "min-h-0 flex-1 font-inter",
                                                model.preview.kind === "ready"
                                                    ? "px-4 pt-4 pb-4 sm:px-6 sm:pt-4 sm:pb-5"
                                                    : model.preview.kind === "empty"
                                                      ? undefined
                                                      : "p-4 sm:px-6 sm:py-5",
                                                model.preview.kind === "empty" && "flex min-h-0 flex-1 flex-col",
                                            )}
                                        >
                                            {model.preview.kind === "empty" && (
                                                <NativeSessionDirectoryPlaceholder
                                                    icon={MessageSquare}
                                                    title="Select a session"
                                                    description="Preview its message history here."
                                                />
                                            )}
                                            {model.preview.kind === "loading" && <NativeSessionPreviewSkeleton />}
                                            {model.preview.kind === "failed" && (
                                                <div role="alert" className="flex items-start gap-2 text-destructive">
                                                    <p className="min-w-0 flex-1 break-words">
                                                        {model.preview.message}
                                                    </p>
                                                    {reportButton}
                                                </div>
                                            )}
                                            {model.preview.kind === "ready" && (
                                                <div className="space-y-4">
                                                    {model.preview.content.messages.length === 0 && (
                                                        <p>No events in this session.</p>
                                                    )}
                                                    {model.preview.content.messages.map((message) => (
                                                        <MortySessionMessage
                                                            deliveryUnknownUserMessageId={null}
                                                            key={message.firstEvent.eventId}
                                                            message={message}
                                                            onRemoveUnknownDelivery={() => undefined}
                                                            onRetryUnknownDelivery={() => undefined}
                                                            openLocalFile={() => undefined}
                                                            retryUnknownDeliveryDisabled
                                                        />
                                                    ))}
                                                    {model.preview.content.truncated && (
                                                        <p className="text-13 text-morty-text-3">
                                                            Showing a partial event preview.
                                                        </p>
                                                    )}
                                                </div>
                                            )}
                                        </ScrollEdgeFade>
                                    </section>
                                    {model.error !== "" && (
                                        <div
                                            className="mx-4 flex items-start gap-2 rounded-2xl border border-destructive/20 bg-card px-4 py-3 text-13 text-destructive sm:mx-5"
                                            role="alert"
                                        >
                                            <span className="min-w-0 flex-1 break-words">{model.error}</span>
                                            {reportButton}
                                        </div>
                                    )}
                                    {/* Both actions need a session: with nothing previewed they would be dead controls. */}
                                    {model.preview.kind !== "empty" && (
                                        <footer className="flex shrink-0 justify-end gap-2 px-4 py-3 sm:px-5">
                                            <Button
                                                className={sheetControlHeightClassName}
                                                variant="outline"
                                                disabled={
                                                    model.preview.kind !== "ready" ||
                                                    model.operation !== "idle" ||
                                                    model.directory.kind !== "ready" ||
                                                    (!model.directory.capabilities.loadSession &&
                                                        !model.directory.capabilities.resumeSession)
                                                }
                                                onClick={() =>
                                                    withSignal(
                                                        async (signal) => await store.getState().open("import", signal),
                                                    )
                                                }
                                            >
                                                {model.operation === "import" ? "Opening…" : "Open"}
                                            </Button>
                                            <Button
                                                className={sheetControlHeightClassName}
                                                disabled={model.preview.kind !== "ready" || model.operation !== "idle"}
                                                onClick={() =>
                                                    withSignal(
                                                        async (signal) => await store.getState().open("fork", signal),
                                                    )
                                                }
                                            >
                                                {model.operation === "fork" ? "Forking…" : "Fork"}
                                            </Button>
                                        </footer>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </>
            )}
        </SheetDialog>
    );
}
