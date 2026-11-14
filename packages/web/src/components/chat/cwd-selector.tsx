import { Check, ChevronRight, Folder, FolderOpen, LoaderCircle, MapPinPlus, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useState } from "react";
import { dataTestId } from "@/data-testid";
import { cn } from "@/lib/utils";
import type { DraftControlsStore } from "@/view-models/chat/draft-controls-store";
import { Button } from "../ui/cloud-button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { MortyTooltipContent } from "../ui/morty-tooltip-content.tsx";
import {
    overlayMenuSeparatorClassName,
    overlaySurfacePanelClassName,
    overlaySurfaceRadiusClassName,
    overlayTriggerOffsetPx,
} from "../ui/overlay-surface.ts";
import { Popover } from "../ui/popover.tsx";
import { ScrollEdgeFade } from "../utils/scroll-edge-fade.tsx";
import { StartClippedLabel } from "../utils/start-clipped-label.tsx";

const workingDirectoryLabelClassName =
    "inline-flex min-h-9 min-w-0 max-w-[200px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2 py-1.5 text-[13px] font-normal text-morty-text-3 outline-none";

export function WorkingDirectorySkeleton({ className }: { readonly className?: string }) {
    return (
        <div
            aria-label="Loading working directory"
            className={cn("flex h-9 w-40 max-w-[200px] shrink-0 items-center", className)}
            role="status"
        >
            <span className="sr-only">Loading working directory</span>
            <div
                aria-hidden="true"
                className="h-4 w-full animate-pulse rounded-full bg-muted motion-reduce:animate-none"
            />
        </div>
    );
}

export function ReadonlyWorkingDirectory({
    className,
    clip = "start",
    directoryLabel,
}: {
    readonly className?: string;
    readonly clip?: "start" | "end";
    readonly directoryLabel: string;
}) {
    return (
        <Tooltip.Provider delayDuration={150}>
            <Tooltip.Root>
                <Tooltip.Trigger asChild>
                    <span
                        className={cn(workingDirectoryLabelClassName, className)}
                        data-testid={dataTestId.workingDirectory}
                        title={directoryLabel}
                    >
                        <FolderOpen aria-hidden="true" className="shrink-0 text-morty-text-3/60 size-3" />
                        <StartClippedLabel clip={clip} value={directoryLabel} />
                    </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                    <MortyTooltipContent
                        className="max-w-80 break-all px-3 py-2 leading-5"
                        side="bottom"
                        sideOffset={8}
                    >
                        {directoryLabel}
                        <Tooltip.Arrow className="fill-foreground" />
                    </MortyTooltipContent>
                </Tooltip.Portal>
            </Tooltip.Root>
        </Tooltip.Provider>
    );
}

export function CwdSelector({
    disabled,
    signal,
    viewModel,
}: {
    readonly disabled: boolean;
    readonly signal: AbortSignal;
    readonly viewModel: DraftControlsStore;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    const settings = viewModel.settings;
    if (settings.kind !== "ready") {
        return null;
    }
    const browser = viewModel.cwdBrowser;
    const workingDirectory = settings.cwd.directoryLabel;
    const directory = browser.kind === "closed" ? null : browser.directory;
    const directoryNavigationDisabled = browser.kind === "previewing";
    const directoryPending = browser.kind === "loading" || browser.kind === "previewing";
    return (
        <>
            <Popover.Root
                onOpenChange={(open) => {
                    if (open) {
                        viewModel.refreshRecentCwds();
                    }
                    setMenuOpen(open);
                }}
                open={menuOpen}
            >
                <Tooltip.Provider delayDuration={150}>
                    <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                            <Popover.Trigger asChild>
                                <Button
                                    aria-label={`Working directory: ${workingDirectory}`}
                                    className="min-w-0 max-w-[200px] bg-morty-fill-opacity-2 hover:bg-morty-fill-opacity-3! data-[state=open]:bg-morty-fill-opacity-3 data-[state=open]:text-foreground"
                                    data-testid={dataTestId.workingDirectory}
                                    disabled={disabled}
                                    variant="ghost"
                                >
                                    <FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
                                    <StartClippedLabel value={workingDirectory} />
                                </Button>
                            </Popover.Trigger>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                            <MortyTooltipContent
                                className="max-w-80 break-all px-3 py-2 leading-5"
                                side="top"
                                sideOffset={8}
                            >
                                {workingDirectory}
                                <Tooltip.Arrow className="fill-foreground" />
                            </MortyTooltipContent>
                        </Tooltip.Portal>
                    </Tooltip.Root>
                </Tooltip.Provider>
                <Popover.Portal>
                    <Popover.Content
                        align="start"
                        aria-label="Working directory menu"
                        className={cn(
                            "z-50 flex max-h-[min(70dvh,520px)] w-[min(calc(100vw-1.5rem),320px)] animate-cloud-enter flex-col overflow-hidden p-1.5 text-sm text-foreground outline-none motion-reduce:animate-none",
                            overlaySurfacePanelClassName,
                            overlaySurfaceRadiusClassName,
                        )}
                        role="menu"
                        side="top"
                        sideOffset={overlayTriggerOffsetPx}
                    >
                        <Tooltip.Provider delayDuration={150}>
                            <ScrollEdgeFade
                                className="max-h-80"
                                edgeStroke={{ className: "border-white/80", placement: "inside" }}
                                revealSurface
                            >
                                {viewModel.recentCwds.map((recent) => {
                                    const selected = recent.directory === settings.cwd.directory;
                                    return (
                                        <div
                                            className="group/recent relative flex h-9 items-center rounded-md hover:bg-accent focus-within:bg-accent"
                                            key={recent.directory}
                                        >
                                            <button
                                                className={cn(
                                                    "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-left outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60",
                                                    selected && "pr-7",
                                                )}
                                                data-testid={dataTestId.recentWorkingDirectory}
                                                onClick={() => {
                                                    setMenuOpen(false);
                                                    void viewModel.selectRecentCwd(recent.directory, signal);
                                                }}
                                                role="menuitem"
                                                title={recent.directoryLabel}
                                                type="button"
                                            >
                                                <Folder aria-hidden="true" className="size-4 shrink-0" />
                                                <StartClippedLabel value={recent.directoryLabel} />
                                            </button>
                                            {selected ? (
                                                <Check
                                                    aria-hidden="true"
                                                    className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-foreground group-hover/recent:-translate-x-7 group-focus-within/recent:-translate-x-7"
                                                />
                                            ) : null}
                                            <Tooltip.Root>
                                                <Tooltip.Trigger asChild>
                                                    <button
                                                        aria-label={`Forget recent working directory ${recent.directoryLabel}`}
                                                        className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-accent hover:text-copy-primary focus-visible:opacity-100 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 group-hover/recent:opacity-100 group-focus-within/recent:opacity-100 motion-reduce:transition-none"
                                                        data-testid={dataTestId.forgetRecentWorkingDirectory}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            viewModel.forgetRecentCwd(recent.directory);
                                                        }}
                                                        type="button"
                                                    >
                                                        <X aria-hidden="true" className="size-4" />
                                                    </button>
                                                </Tooltip.Trigger>
                                                <Tooltip.Portal>
                                                    <MortyTooltipContent side="top" sideOffset={overlayTriggerOffsetPx}>
                                                        Forget recent location
                                                        <Tooltip.Arrow className="fill-foreground" />
                                                    </MortyTooltipContent>
                                                </Tooltip.Portal>
                                            </Tooltip.Root>
                                        </div>
                                    );
                                })}
                            </ScrollEdgeFade>
                            <hr className={cn("-mx-1.5 my-1.5 border-0", overlayMenuSeparatorClassName)} />
                            <button
                                className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-full px-3 text-left outline-none hover:bg-accent keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60"
                                data-testid={dataTestId.changeWorkingDirectory}
                                onClick={() => {
                                    setMenuOpen(false);
                                    viewModel.openCwd();
                                }}
                                role="menuitem"
                                type="button"
                            >
                                <MapPinPlus aria-hidden="true" className="size-4" />
                                Change to a new location
                            </button>
                        </Tooltip.Provider>
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
            {browser.kind !== "closed" && (
                <Dialog
                    description="Browse folders on your local computer or enter an absolute folder path."
                    onClose={viewModel.closeCwd}
                    title="Choose working directory"
                >
                    <div className="grid gap-4">
                        <label className="grid gap-1.5">
                            <span className="text-xs font-medium text-copy-tertiary">Working directory path</span>
                            <input
                                aria-label="Working directory path"
                                className="h-10 rounded-lg border border-border bg-white px-3 text-[13px] outline-none keyboard-focus:focus:border-ring keyboard-focus:focus:ring-[3px] keyboard-focus:focus:ring-ring/15"
                                data-testid={dataTestId.workingDirectoryPath}
                                onChange={(event) => viewModel.setCwdPath(event.currentTarget.value, signal)}
                                value={browser.path}
                            />
                        </label>
                        <section
                            aria-busy={directoryPending}
                            aria-disabled={directoryNavigationDisabled}
                            aria-label={directory === null ? undefined : `Folders in ${directory.directoryLabel}`}
                            className="min-h-56 overflow-hidden rounded-lg border border-border bg-surface-subtle/50"
                            data-testid={dataTestId.workingDirectoryPreview}
                        >
                            {browser.kind === "loading" ? (
                                <p
                                    className="flex min-h-56 items-center justify-center gap-2 text-muted-foreground"
                                    role="status"
                                >
                                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                                    Opening folder…
                                </p>
                            ) : (
                                <>
                                    {browser.kind === "failed" && (
                                        <p
                                            className="border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive"
                                            role="alert"
                                        >
                                            {browser.message}
                                        </p>
                                    )}
                                    {directory !== null && (
                                        <ScrollEdgeFade
                                            scrollElement="ul"
                                            aria-label={`Folders in ${directory.directoryLabel}`}
                                            revealSurface
                                            edgeStroke={{ className: "border-surface-subtle/50", placement: "inside" }}
                                            frameClassName={directoryNavigationDisabled ? "opacity-50" : ""}
                                            className="max-h-64 p-2"
                                        >
                                            {directory.parentDirectory.length > 0 && (
                                                <li>
                                                    <button
                                                        className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-accent disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                                        disabled={directoryNavigationDisabled}
                                                        onClick={() =>
                                                            void viewModel.browseCwd(directory.parentDirectory, signal)
                                                        }
                                                        type="button"
                                                    >
                                                        <Folder aria-hidden="true" className="size-4" />
                                                        <span className="flex-1">..</span>
                                                        <ChevronRight aria-hidden="true" className="size-4" />
                                                    </button>
                                                </li>
                                            )}
                                            {directory.entries.map((entry) => (
                                                <li key={entry.directory}>
                                                    <button
                                                        aria-label={entry.name}
                                                        className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-accent disabled:cursor-not-allowed disabled:hover:bg-transparent"
                                                        disabled={directoryNavigationDisabled}
                                                        onClick={() =>
                                                            void viewModel.browseCwd(entry.directory, signal)
                                                        }
                                                        type="button"
                                                    >
                                                        <Folder aria-hidden="true" className="size-4" />
                                                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                                                        <ChevronRight aria-hidden="true" className="size-4" />
                                                    </button>
                                                </li>
                                            ))}
                                        </ScrollEdgeFade>
                                    )}
                                </>
                            )}
                        </section>
                    </div>
                    <footer className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
                        <Button onClick={viewModel.closeCwd} variant="outline">
                            Cancel
                        </Button>
                        <Button
                            data-testid={dataTestId.saveWorkingDirectory}
                            disabled={directoryPending}
                            onClick={() => void viewModel.saveCwd(signal)}
                        >
                            Save
                        </Button>
                    </footer>
                </Dialog>
            )}
        </>
    );
}
