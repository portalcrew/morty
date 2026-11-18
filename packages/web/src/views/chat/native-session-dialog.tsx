import { ChevronLeft, CircleAlert, Inbox, LoaderCircle, MessageSquare, PackageOpen, Unplug } from "lucide-react";
import type { ReactNode, UIEvent } from "react";
import { useStore } from "zustand";
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
import { ScrollEdgeFade } from "../../components/utils/scroll-edge-fade.tsx";
import { dataTestId } from "../../data-testid.ts";
import { cn } from "../../lib/utils.ts";
import type { ManagedChatSession } from "../../services/chat/bot-chat-api.ts";
import type { DaemonDiagnosticsSource } from "../../services/diagnostics/browser-diagnostics.ts";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import type { NativeSessionAgent } from "../../view-models/chat/native-session-agents.ts";
import { type NativeSessionStore, nativeSessionPresentation } from "../../view-models/chat/native-session-store.ts";
import { BugReportButton } from "../diagnostics/bug-report-button.tsx";
import { NativeSessionPreviewMessages } from "./native-session-preview-messages.tsx";

const nativeSessionPreviewCardClassName =
    "min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-white bg-card shadow-module";

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

const SESSION_ROW_SKELETON_WIDTHS = ["w-3/4", "w-2/3", "w-4/5", "w-1/2"] as const;

function NativeSessionDirectoryListSkeleton() {
    return (
        <div aria-hidden="true" className="animate-pulse motion-reduce:animate-none">
            {/* Phone rows: 40px tall within the sheet's 20px content gutter. */}
            <div className="pb-1 sm:hidden">
                {SESSION_ROW_SKELETON_WIDTHS.map((width) => (
                    <div className="flex h-10 items-center px-4" key={width}>
                        <div className={cn("h-3.5 rounded-full bg-morty-fill-opacity-3", width)} />
                    </div>
                ))}
            </div>
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
                    className="border-transparent bg-morty-fill-opacity-3 disabled:opacity-100"
                    disabled
                    key={label}
                    size="lg"
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
            <Button
                aria-busy={busy}
                className="w-full sm:w-auto [&_svg]:size-4"
                disabled={disabled}
                onClick={onMore}
                size="lg"
                variant="ghost"
            >
                <LoaderCircle aria-hidden="true" className={cn(busy && "animate-spin motion-reduce:animate-none")} />
                Load more
            </Button>
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
                        className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 max-sm:px-5 sm:-mx-2.5"
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
    readonly store: StoreApi<NativeSessionStore>;
    readonly sessions: readonly ManagedChatSession[];
    readonly agents: readonly NativeSessionAgent[];
    readonly onClose: () => void;
    readonly onOpenDetail: () => void;
    readonly onBack: () => void;
    readonly step: "list" | "detail";
    readonly bugReportDialog: BugReportDialogStore;
    readonly daemonSource: DaemonDiagnosticsSource;
}) {
    const model = nativeSessionPresentation(useStore(store), sessions);
    const diagnostics: DaemonDiagnosticsSource = {
        ...daemonSource,
        harness: model.directory.kind === "ready" ? model.directory.harness : null,
        sessionId: model.preview.kind === "empty" ? null : model.preview.entry.sessionId,
    };
    const reportEntry = (
        <BugReportButton
            appearance="labelled"
            daemonSource={diagnostics}
            dialog={bugReportDialog}
            size="lg"
            variant="outline"
        />
    );
    const withSignal = (action: (signal: AbortSignal) => Promise<void>) => {
        void action(store.getState().lifetimeSignal());
    };
    const loadMoreOnScroll = (event: UIEvent<HTMLDivElement>) => {
        const viewport = event.currentTarget;
        const bottomGap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (model.operation === "idle" && model.error.length === 0 && viewport.scrollTop > 0 && bottomGap <= 64) {
            withSignal(store.getState().more);
        }
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
            contentOwnsScroll
        >
            {(title) => (
                <>
                    {model.directory.kind === "loading" && model.directory.scope === "initial" ? (
                        <NativeSessionDialogDiscoveringSkeleton title={title} />
                    ) : (
                        <div className="relative grid min-h-0 min-w-0 grid-cols-1 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden sm:h-[min(72dvh,40rem)] sm:grid-cols-[minmax(15rem,16.5rem)_minmax(0,1fr)] sm:grid-rows-1 sm:overflow-visible">
                            <div
                                className={cn(
                                    "flex min-h-0 min-w-0 flex-col gap-1 px-0 transition-[translate,opacity,visibility] duration-200 ease-out motion-reduce:transition-none max-sm:absolute max-sm:inset-0 sm:px-3 sm:transition-none",
                                    step === "list"
                                        ? "visible translate-x-0 opacity-100"
                                        : "invisible pointer-events-none -translate-x-6 opacity-0 sm:visible sm:pointer-events-auto sm:translate-x-0 sm:opacity-100",
                                )}
                            >
                                <div className="max-sm:px-5">{title}</div>
                                <section
                                    aria-label="Native sessions"
                                    className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 max-sm:px-5 sm:-mx-2.5"
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
                                            description={model.directory.message}
                                            action={reportEntry}
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
                                                fadeSize="0.75rem"
                                                frameClassName="flex min-h-0 flex-1 flex-col"
                                                viewportLabel="Saved sessions"
                                                viewportClassName="pb-1 [&>div]:!block [&>div]:!w-full"
                                                onViewportScroll={loadMoreOnScroll}
                                                className={cn(
                                                    // The 40px rows are already the touch target; extra vertical gaps only make the list longer.
                                                    "min-h-0 flex-1 space-y-0",
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
                                                        className={cn("group flex", mobileSheetSessionRowClassName)}
                                                    >
                                                        <span className="w-full min-w-0 truncate font-medium text-copy-secondary">
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
                                            fadeSize="0.75rem"
                                            topClearSize="0.5rem"
                                            edgeStroke={{
                                                className: "border-background",
                                                placement: "outside",
                                                centeredClassName:
                                                    "h-0.5 bg-background border-background transition-none",
                                            }}
                                            frameClassName="hidden min-h-0 flex-1 sm:flex sm:flex-col"
                                            viewportLabel="Saved sessions on desktop"
                                            viewportClassName="pb-2 [&>div]:!block [&>div]:!w-full"
                                            onViewportScroll={loadMoreOnScroll}
                                            className={cn("min-h-0 flex-1 space-y-0 pr-3")}
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
                                    "flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-0 transition-[translate,opacity,visibility] duration-200 ease-out motion-reduce:transition-none max-sm:absolute max-sm:inset-0 sm:transition-none",
                                    step === "detail"
                                        ? "visible translate-x-0 opacity-100"
                                        : "invisible pointer-events-none translate-x-6 opacity-0 sm:visible sm:pointer-events-auto sm:translate-x-0 sm:opacity-100",
                                )}
                            >
                                {/*
                                 * The phone sheet shows this header on its detail step and keeps it mounted for the exit animation; desktop hides it.
                                 * Both gutters are 12px like the actions' distance from the top edge of the 64px row,
                                 * and the right padding clears the 40px close action floating 12px from the sheet edge.
                                 * The title keeps at least 16px from either action: the gap holds 16px after the back
                                 * button, and the right padding is 12px edge + 40px close action + 16px gap.
                                 */}
                                <div
                                    aria-hidden={step !== "detail"}
                                    className="flex h-16 shrink-0 items-center gap-4 pr-[68px] pl-3 sm:hidden"
                                >
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
                                <div
                                    className={cn(nativeSessionPreviewCardClassName, "flex min-h-0 flex-1 max-sm:mx-2")}
                                >
                                    <section
                                        aria-label="Selected session preview"
                                        className="flex min-h-0 min-w-0 flex-1 flex-col"
                                    >
                                        {(model.preview.kind === "ready" || model.preview.kind === "failed") && (
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
                                            <NativeSessionDirectoryPlaceholder
                                                icon={MessageSquare}
                                                title="Select a session"
                                                description="Preview its message history here."
                                            />
                                        )}
                                        {model.preview.kind === "failed" && (
                                            <NativeSessionDirectoryPlaceholder
                                                icon={CircleAlert}
                                                title="Couldn't load preview"
                                                description={model.preview.message}
                                                action={reportEntry}
                                                tone="destructive"
                                            />
                                        )}
                                        {(model.preview.kind === "loading" || model.preview.kind === "ready") && (
                                            <ScrollEdgeFade
                                                revealSurface
                                                edgeStroke={{ className: "border-card", placement: "outside" }}
                                                frameClassName="flex min-h-0 flex-1 flex-col"
                                                viewportClassName="[&>div]:!block [&>div]:!w-full"
                                                scrollToBottomKey={
                                                    model.preview.kind === "ready"
                                                        ? model.preview.entry.sessionId
                                                        : null
                                                }
                                                className={cn(
                                                    "min-h-0 flex-1 font-inter",
                                                    model.preview.kind === "ready"
                                                        ? "px-4 pt-4 pb-4 sm:px-6 sm:pt-4 sm:pb-5"
                                                        : "p-4 sm:px-6 sm:py-5",
                                                )}
                                            >
                                                {model.preview.kind === "loading" && <NativeSessionPreviewSkeleton />}
                                                {model.preview.kind === "ready" && (
                                                    <div>
                                                        {model.preview.content.truncated && (
                                                            <p className="mb-4 py-4 text-center text-13 text-morty-text-3/75">
                                                                Showing a partial event preview.
                                                            </p>
                                                        )}
                                                        {model.preview.content.messages.length === 0 && (
                                                            <p>No events in this session.</p>
                                                        )}
                                                        <NativeSessionPreviewMessages
                                                            collapseStore={store.getState().userMessageCollapse}
                                                            messages={model.preview.content.messages}
                                                        />
                                                    </div>
                                                )}
                                            </ScrollEdgeFade>
                                        )}
                                    </section>
                                    {model.error !== "" && (
                                        <div
                                            className="mx-4 flex flex-col items-start gap-2 rounded-2xl border border-destructive/20 bg-card px-4 py-3 text-13 text-destructive sm:mx-5"
                                            role="alert"
                                        >
                                            <span className="min-w-0 break-words">{model.error}</span>
                                            {reportEntry}
                                        </div>
                                    )}
                                    {/* Both actions need a session: with nothing previewed they would be dead controls. */}
                                    {model.preview.kind !== "empty" && (
                                        <footer className="flex shrink-0 justify-end gap-2 px-4 py-3 sm:px-5">
                                            <Button
                                                variant="outline"
                                                size="lg"
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
                                                size="lg"
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
