import { ArrowUp, FileText, LoaderCircle, Plus, Square, X } from "lucide-react";
import {
    type ClipboardEvent,
    type FormEvent,
    type KeyboardEvent,
    type ReactNode,
    useEffect,
    useRef,
    useState,
} from "react";
import { dataTestId } from "../../data-testid.ts";
import type { ComposerAttachmentStore } from "../../view-models/chat/composer-attachment-store.ts";
import { createFileSource } from "../images/file-source.ts";
import { ImageGallery, PreviewImage } from "../images/image-gallery.tsx";
import { Button } from "../ui/cloud-button.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { useToast } from "../ui/toast.tsx";
import { useAutoGrowingTextarea } from "../utils/use-auto-growing-textarea.ts";
import { useComposerFocus } from "../utils/use-composer-focus.ts";
import { useScrollClippedEdges } from "../utils/use-scroll-clipped-edges.ts";
import { useSoftwareKeyboardMarker } from "../utils/use-software-keyboard-marker.ts";
import { chatSessionComposerClassName } from "./chat-session-layout.ts";
import type { ComposerAttachment } from "./composer-attachment.ts";
import { type ComposerNoticePlacement, ComposerNoticeSlot, composerErrorMessage } from "./composer-notice-slot.tsx";

const composerMaxHeightPx = 256;
const composerChromeHeightPx = 64;
const composerTextareaMaxHeightPx = composerMaxHeightPx - composerChromeHeightPx;
const composerScrollEdgeThresholdPx = 1;
const composerActionButtonClassName =
    "size-8! rounded-full bg-foreground text-background hover:bg-foreground/85 active:bg-foreground/75";

function attachmentName(attachment: ComposerAttachment): string {
    return attachment.name;
}

function AttachmentImage({ attachment }: { readonly attachment: ComposerAttachment }) {
    const [source, setSource] = useState("");
    useEffect(() => {
        const file = createFileSource(attachment.bytes, attachment.mediaType);
        setSource(file.source);
        return file.release;
    }, [attachment]);
    return source.length === 0 ? null : (
        <span className="inline-flex size-11 shrink-0 items-center justify-center">
            <PreviewImage
                alt={attachment.name}
                className="size-11 rounded-lg object-contain"
                height={44}
                src={source}
                width={44}
            />
        </span>
    );
}

function AttachmentPreview({
    attachment,
    disabled,
    onRemove,
}: {
    readonly attachment: ComposerAttachment;
    /** A disabled composer cannot change what it holds, attachments included. */
    readonly disabled: boolean;
    readonly onRemove: () => void;
}) {
    const name = attachmentName(attachment);
    return (
        <li className="group/attachment relative flex h-[60px] max-w-52 items-center gap-2 rounded-md border border-border bg-surface-subtle p-2 pr-8 text-xs text-copy-secondary">
            {attachment.kind === "image" ? (
                <AttachmentImage attachment={attachment} />
            ) : (
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-white text-muted-foreground shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                    <FileText aria-hidden="true" className="size-5" />
                </span>
            )}
            <span className="min-w-0 truncate" title={name}>
                {name}
            </span>
            <button
                aria-label={`Remove ${name}`}
                className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-black/[0.06] hover:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50"
                disabled={disabled}
                onClick={onRemove}
                type="button"
            >
                <X aria-hidden="true" className="size-3.5" />
            </button>
        </li>
    );
}

export function BotChatComposer({
    attachmentModel,
    focusScope,
    canAttach,
    attachmentSignal,
    children,
    disabled,
    draft,
    error,
    connectionNotice,
    statusMessage,
    noticePlacement = "overlay",
    onDraftChange,
    onStop,
    onSubmit,
    outputState,
    sendBlockedMessage,
    submitDisabled,
    stopDisabled = false,
}: {
    readonly attachmentModel: ComposerAttachmentStore;
    readonly focusScope?: object;
    readonly canAttach: boolean;
    readonly attachmentSignal: AbortSignal;
    readonly children: ReactNode;
    readonly disabled: boolean;
    readonly draft: string;
    readonly error: string;
    /**
     * The connection notice for this composer, as a render function because only the
     * composer knows whether a send or attachment failure owns the headline. The
     * notice renders its own surface when it stands alone, and folds itself into the
     * failure's detail line when one is present, so a failure never nests a second
     * card and a second assertive region inside itself.
     */
    readonly connectionNotice?: ((inline: boolean) => ReactNode) | undefined;
    readonly statusMessage?: string | undefined;
    /**
     * Where the notice slot sits. "overlay" renders it inside this form, floating
     * over the message log with the frosted tuck; "in-flow" lets the pane render it
     * at the top of the queue/interaction stack instead, so the queue card keeps
     * sitting against the input box and the notice covers nothing.
     */
    readonly noticePlacement?: ComposerNoticePlacement;
    readonly onDraftChange: (draft: string) => void;
    readonly onStop: () => void;
    readonly onSubmit: () => void;
    readonly outputState: "idle" | "sending" | "running" | "stopping";
    /** Why a draft cannot be sent while this Session reconnects. */
    readonly sendBlockedMessage?: string | undefined;
    readonly submitDisabled: boolean;
    readonly stopDisabled?: boolean;
}) {
    const fileInput = useRef<HTMLInputElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const scrollViewport = useRef<HTMLDivElement>(null);
    const attachTextarea = useComposerFocus(textarea, focusScope);
    useAutoGrowingTextarea(textarea, draft, scrollViewport);
    const clipped = useScrollClippedEdges(scrollViewport, composerScrollEdgeThresholdPx);
    const { attachments, state: attachmentState } = attachmentModel;
    const showToast = useToast();
    const explainBlockedSend =
        outputState === "idle" &&
        submitDisabled &&
        sendBlockedMessage !== undefined &&
        attachmentState.kind !== "reading" &&
        (draft.trim().length > 0 || attachments.length > 0);

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        if (!submitDisabled) {
            onSubmit();
            // Touch devices drop the software keyboard so the reply is visible; keyboard users keep typing.
            if (window.matchMedia("(pointer: coarse)").matches) {
                textarea.current?.blur();
            } else {
                textarea.current?.focus({ preventScroll: true });
            }
        } else if (explainBlockedSend) {
            showToast({
                title: sendBlockedMessage,
                description: "Your draft is saved. Try again when the connection returns.",
                variant: "error",
            });
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key === "Enter" && event.ctrlKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.setRangeText(
                "\n",
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
                "end",
            );
            onDraftChange(event.currentTarget.value);
            return;
        }
        if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.nativeEvent.isComposing
        ) {
            return;
        }
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
    };
    const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
        if (images.length === 0 || disabled || !canAttach) {
            return;
        }
        event.preventDefault();
        attachmentModel.addFiles(images, attachmentSignal);
    };
    const submitAction = outputState === "idle" || (outputState === "running" && !submitDisabled);
    const errorMessage = composerErrorMessage(error, attachmentState);
    const attachKeyboardMarker = useSoftwareKeyboardMarker();

    return (
        <form className={chatSessionComposerClassName} onSubmit={submit} ref={attachKeyboardMarker}>
            {noticePlacement === "overlay" && (
                <ComposerNoticeSlot
                    connectionNotice={connectionNotice}
                    errorMessage={errorMessage}
                    placement="overlay"
                    statusMessage={statusMessage}
                />
            )}
            <div className="flex max-h-64 flex-col rounded-[24px] border-[0.5px] border-border bg-surface-elevated px-3 pt-3 pb-2.5 shadow-[0_8px_28px_rgba(23,30,36,0.06)] has-[:focus]:border-[var(--color-border)] sm:min-h-[128px] sm:pb-3">
                {attachments.length > 0 && (
                    <ImageGallery>
                        <ul aria-label="Attachments" className="mb-2 flex list-none flex-wrap gap-2 p-0">
                            {attachments.map((attachment, index) => (
                                <AttachmentPreview
                                    attachment={attachment}
                                    disabled={disabled}
                                    key={`${attachment.kind}:${attachmentName(attachment)}:${index.toString()}`}
                                    onRemove={() => attachmentModel.remove(index)}
                                />
                            ))}
                        </ul>
                    </ImageGallery>
                )}
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <ScrollArea
                        className="-mx-3 flex min-h-0 flex-1 flex-col"
                        type="auto"
                        viewportClassName="min-h-0 flex-1"
                        viewportRef={scrollViewport}
                        viewportStyle={{ maxHeight: composerTextareaMaxHeightPx }}
                    >
                        <Textarea
                            aria-describedby="chat-composer-keyboard-hint"
                            aria-label="Message"
                            className="mb-2 min-h-[56px] w-full resize-none overflow-hidden px-4 pt-0 pb-1 text-14 placeholder:text-14 sm:min-h-[64px]"
                            data-testid={dataTestId.messageComposer}
                            disabled={disabled}
                            onChange={(event) => onDraftChange(event.target.value)}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            placeholder="Ask me anything"
                            ref={attachTextarea}
                            value={draft}
                        />
                    </ScrollArea>
                    <div
                        aria-hidden="true"
                        className={`pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-surface-elevated to-surface-elevated/0 transition-opacity duration-150 motion-reduce:transition-none ${clipped.top ? "opacity-100" : "opacity-0"}`}
                    />
                    <div
                        aria-hidden="true"
                        className={`pointer-events-none absolute inset-x-0 -bottom-1 h-8 bg-gradient-to-t from-surface-elevated to-surface-elevated/0 transition-opacity duration-150 motion-reduce:transition-none ${clipped.bottom ? "opacity-100" : "opacity-0"}`}
                    />
                </div>
                <div className="mt-1 flex shrink-0 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1">
                        <button
                            aria-label="Add attachment"
                            className="flex size-9 items-center justify-center rounded-full text-copy-secondary outline-none transition-colors duration-150 hover:bg-black/[0.045] hover:text-foreground active:bg-black/[0.07] active:text-foreground keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/60 disabled:opacity-50 motion-reduce:transition-none"
                            disabled={disabled || !canAttach}
                            onClick={() => fileInput.current?.click()}
                            title="Add attachment"
                            type="button"
                        >
                            {attachmentState.kind === "reading" ? (
                                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                            ) : (
                                <Plus className="size-4" />
                            )}
                        </button>
                        <input
                            aria-label="Choose attachments"
                            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.svg,application/pdf,.pdf,text/*,.md,.json,.csv,.yaml,.yml,.xml"
                            className="sr-only"
                            disabled={disabled}
                            multiple
                            onChange={(event) => {
                                if (event.currentTarget.files !== null) {
                                    attachmentModel.addFiles(Array.from(event.currentTarget.files), attachmentSignal);
                                    event.currentTarget.value = "";
                                }
                            }}
                            ref={fileInput}
                            type="file"
                        />
                        <ScrollArea className="min-w-0" orientation="horizontal" viewportClassName="w-full">
                            <div className="flex w-max min-w-full items-center gap-1">{children}</div>
                        </ScrollArea>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button
                            aria-busy={outputState === "sending"}
                            aria-disabled={explainBlockedSend || undefined}
                            aria-label={
                                outputState === "sending"
                                    ? "Sending message"
                                    : outputState === "stopping"
                                      ? "Stopping agent output"
                                      : submitAction
                                        ? "Send message"
                                        : "Stop agent output"
                            }
                            className={`${composerActionButtonClassName}${explainBlockedSend ? " opacity-50" : ""}`}
                            data-testid={dataTestId.sendMessage}
                            disabled={
                                outputState === "sending" ||
                                outputState === "stopping" ||
                                (outputState === "idle" && submitDisabled && !explainBlockedSend) ||
                                (outputState === "running" && stopDisabled)
                            }
                            onClick={outputState === "running" && !submitAction ? onStop : undefined}
                            size="icon"
                            title={explainBlockedSend ? sendBlockedMessage : undefined}
                            type={submitAction ? "submit" : "button"}
                        >
                            {submitAction || outputState === "sending" ? (
                                <ArrowUp aria-hidden="true" className="size-[18px]" />
                            ) : (
                                <Square aria-hidden="true" className="size-3! fill-current" />
                            )}
                        </Button>
                    </div>
                </div>
            </div>
            <span className="sr-only" id="chat-composer-keyboard-hint">
                Enter to send. Shift or Control plus Enter inserts a new line.
            </span>
        </form>
    );
}
