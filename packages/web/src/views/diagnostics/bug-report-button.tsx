import { Bug, ChevronDown, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import { useStore } from "zustand";
import { AttachCancelBoundary, HiddenFileInput } from "../../components/diagnostics/attach-controls.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import {
    Dialog,
    dialogBodyStackClassName,
    dialogPinnedFooterActionsClassName,
    dialogSectionTitleClassName,
} from "../../components/ui/dialog.tsx";
import { MortyAlert } from "../../components/ui/morty-alert.tsx";
import { ObjectUrlImage } from "../../components/ui/object-url-image.tsx";
import { ScrollArea } from "../../components/ui/scroll-area.tsx";
import { formFieldShellClassName, formTextareaClassName, Textarea } from "../../components/ui/textarea.tsx";
import { cn } from "../../lib/utils.ts";
import type { DaemonDiagnosticsSource } from "../../services/diagnostics/browser-diagnostics.ts";
import type { BugReportDialogStore } from "../../view-models/bug-report-dialog-store.ts";
import {
    type BugReportImage,
    type BugReportStoreApi,
    bugReportImageAccept,
} from "../../view-models/bug-report-store.ts";
import { mobileDrawerCardRowClassName } from "../chat/computer-switcher.tsx";

const appearances = {
    floating: "fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] right-2 z-40 bg-background/90 text-xs",
    icon: "size-8! min-h-8! shrink-0 justify-center rounded-full px-0 text-copy-secondary hover:bg-morty-fill-opacity-2 active:bg-morty-fill-opacity-3",
    labelled: "min-h-10 shrink-0 text-xs",
};

export function BugReportButton({
    appearance = "labelled",
    daemonSource = null,
    dialog,
}: {
    readonly appearance?: keyof typeof appearances | "card";
    readonly daemonSource?: DaemonDiagnosticsSource | null;
    readonly dialog: BugReportDialogStore;
}) {
    const showBugReport = dialog.getState().show;
    const trigger =
        appearance === "card" ? (
            <button
                type="button"
                aria-label="Report a bug"
                className={mobileDrawerCardRowClassName}
                onClick={(event) => {
                    if (event.detail > 0) {
                        event.currentTarget.blur();
                    }
                    showBugReport(daemonSource);
                }}
            >
                <Bug aria-hidden="true" className="size-5 shrink-0 text-copy-secondary" />
                Report a bug
            </button>
        ) : (
            <Button
                aria-label="Report a bug"
                className={appearances[appearance]}
                onClick={(event) => {
                    if (event.detail > 0) {
                        event.currentTarget.blur();
                    }
                    showBugReport(daemonSource);
                }}
                variant="ghost"
            >
                {appearance === "icon" ? <Bug aria-hidden="true" className="size-4" /> : "Report a bug"}
            </Button>
        );
    return appearance === "icon" ? (
        <Tooltip.Provider delayDuration={150} disableHoverableContent>
            <Tooltip.Root>
                <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
                <Tooltip.Portal>
                    <Tooltip.Content
                        className="z-[70] rounded-lg bg-foreground px-2.5 py-1.5 text-xs text-background shadow-lg"
                        side="top"
                        sideOffset={6}
                    >
                        Report a bug
                        <Tooltip.Arrow className="fill-foreground" />
                    </Tooltip.Content>
                </Tooltip.Portal>
            </Tooltip.Root>
        </Tooltip.Provider>
    ) : (
        trigger
    );
}

/**
 * Renders the shared bug-report dialog for the whole application. Entry-point
 * buttons only trigger `show`; the dialog itself must outlive any single
 * button mount, for example the floating trigger on the loading page that
 * unmounts when loading completes.
 */
export function BugReportDialogHost({ dialog }: { readonly dialog: BugReportDialogStore }) {
    const open = useStore(dialog, (state) => state.open);
    const report = useStore(dialog, (state) => state.report);
    return open && report !== null ? <BugReportDialog dialog={dialog} key="bug-report-dialog" report={report} /> : null;
}

function ReportImage({
    image,
    disabled,
    onRemove,
}: {
    readonly image: BugReportImage;
    readonly disabled: boolean;
    readonly onRemove: () => void;
}) {
    return (
        <li className="group relative flex h-[60px] w-[200px] max-w-full shrink-0 items-center gap-2 rounded-[16px] bg-morty-fill-opacity-2 py-2 pr-4 pl-2 text-sm text-copy-secondary hover:pr-9 focus-within:pr-9 [@media(hover:none)]:pr-9">
            <ObjectUrlImage
                alt={image.file.name}
                className="aspect-square size-11 shrink-0 rounded-[10px] object-cover"
                file={image.file}
            />
            <span className="min-w-0 truncate font-medium" title={image.file.name}>
                {image.file.name}
            </span>
            <button
                aria-label={`Remove ${image.file.name}`}
                className="absolute top-1/2 right-2.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-black/[0.06] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 disabled:opacity-50 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
                disabled={disabled}
                onClick={onRemove}
                type="button"
            >
                <X aria-hidden="true" className="size-3.5" />
            </button>
        </li>
    );
}

function BugReportDialog({
    dialog,
    report,
}: {
    readonly dialog: BugReportDialogStore;
    readonly report: BugReportStoreApi;
}) {
    const hideBugReport = dialog.getState().hide;
    const { state, description, images, technicalDetails, addImages, removeImage, describe, send, close } =
        useStore(report);
    const closeDialog = () => {
        close();
        hideBugReport();
    };
    return (
        <Dialog
            title="Report a bug"
            description="Send a description, optional images and recent technical and network diagnostics to the Morty team. Session text, other files and credentials are not collected automatically."
            onClose={closeDialog}
            footer={
                state.kind === "sent" ? undefined : (
                    <div className={dialogPinnedFooterActionsClassName}>
                        <Button
                            type="submit"
                            form="bug-report-form"
                            disabled={state.kind === "sending" || description.trim() === ""}
                        >
                            Send report
                        </Button>
                    </div>
                )
            }
        >
            <AttachCancelBoundary
                cancel={() => {
                    // Unmounting (for example when application loading
                    // completes) only cancels the in-flight send; whether the
                    // dialog stays open belongs to its owner, not the mount
                    // that happened to render it.
                    report.getState().close();
                }}
            >
                {state.kind === "sent" ? (
                    <div role="status" className="break-all">
                        <p>Report sent. Reference: {state.id}</p>
                        {!state.daemonAvailable && (
                            <p>Daemon diagnostics were unavailable; Web diagnostics were included.</p>
                        )}
                        {state.truncated && <p>Older diagnostics were omitted to keep this report small.</p>}
                    </div>
                ) : (
                    <form
                        id="bug-report-form"
                        onPaste={(event) => {
                            const files = Array.from(event.clipboardData.files);
                            if (files.length > 0) {
                                event.preventDefault();
                                addImages(files);
                            }
                        }}
                        onSubmit={(event) => {
                            event.preventDefault();
                            void send();
                        }}
                        className={cn(dialogBodyStackClassName, "gap-4")}
                    >
                        <label className="grid gap-2" htmlFor="bug-description">
                            <span className={dialogSectionTitleClassName}>What went wrong?</span>
                            <div className={formFieldShellClassName}>
                                <Textarea
                                    id="bug-description"
                                    className={`${formTextareaClassName} min-h-28`}
                                    maxLength={2000}
                                    placeholder="Describe what you expected and what happened"
                                    required
                                    disabled={state.kind === "sending"}
                                    value={description}
                                    onChange={(event) => describe(event.target.value)}
                                />
                            </div>
                        </label>
                        {images.length > 0 && (
                            <ul aria-label="Attached images" className="flex flex-wrap gap-2">
                                {images.map((image) => (
                                    <ReportImage
                                        key={image.id}
                                        image={image}
                                        disabled={state.kind === "sending"}
                                        onRemove={() => removeImage(image.id)}
                                    />
                                ))}
                            </ul>
                        )}
                        <div className="space-y-2">
                            <HiddenFileInput
                                accept={bugReportImageAccept}
                                ariaLabel="Attach images"
                                disabled={state.kind === "sending"}
                                multiple
                                onFiles={addImages}
                            />
                            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground marker:text-morty-text-4">
                                <li>Paste or attach up to 3 images (PNG, JPEG, GIF, or WebP; 2.5 MB each).</li>
                                <li>
                                    Keep chat text, personal details, and secrets out of images and your description.
                                </li>
                            </ul>
                        </div>
                        <details className="disclosure-details group text-13 leading-5 text-morty-text-3">
                            <summary className="flex h-6 cursor-pointer list-none items-center gap-1.5 rounded-lg outline-none hover:text-morty-text-2 keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                                Agent and model details included
                                <ChevronDown
                                    aria-hidden="true"
                                    className="size-3.5 transition-[rotate] duration-300 ease-out group-open:rotate-180 motion-reduce:transition-none"
                                />
                            </summary>
                            <div className="mt-2 rounded-[16px] border border-border/60 bg-[#f2f3f5] px-3.5 py-3">
                                <p>
                                    Captured when this report was opened. Custom model names use anonymous labels within
                                    this report.
                                </p>
                                <ScrollArea
                                    className="mt-2 max-h-48"
                                    orientation="both"
                                    viewportClassName="max-h-[inherit]"
                                >
                                    <pre className="whitespace-pre-wrap break-all">{technicalDetails}</pre>
                                </ScrollArea>
                            </div>
                        </details>
                        <p className="text-xs text-muted-foreground">
                            Network and daemon diagnostics are collected automatically and may take up to 10 seconds.
                            You can still send a report when your Computer is offline.
                        </p>
                        {state.kind === "failed" && <MortyAlert tone="error">{state.message}</MortyAlert>}
                        {state.kind === "sending" && <p role="status">Collecting diagnostics and sending…</p>}
                    </form>
                )}
            </AttachCancelBoundary>
        </Dialog>
    );
}
