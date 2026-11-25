import { type ReactNode, useRef } from "react";
import type { AttachmentRejection, ComposerAttachmentStore } from "../../view-models/chat/composer-attachment-store.ts";
import { MortyAlert } from "../ui/morty-alert.tsx";
import { useComposerNoticeLayout } from "../utils/use-composer-notice-layout.ts";

export type ComposerNoticePlacement = "overlay" | "in-flow";

function rejectionReason(reason: Exclude<AttachmentRejection["reason"], "attachment_limit">): string {
    switch (reason) {
        case "attachment_empty":
            return "the file is empty";
        case "attachment_too_large":
            return "files can be up to 32 MB";
        case "attachment_image_too_large":
            return "images can be up to 5 MB";
        case "attachment_timeout":
            return "it took too long to read";
        case "attachment_cancelled":
        case "attachment_read_failed":
        case "attachment_image_invalid":
        case "attachment_resize_failed":
            return "it couldn't be read";
    }
}

function attachmentRejectionMessage(rejections: readonly AttachmentRejection[]): string {
    const sentences: string[] = [];
    const overLimit: Extract<AttachmentRejection, { readonly reason: "attachment_limit" }>[] = [];
    for (const rejection of rejections) {
        if (rejection.reason === "attachment_limit") {
            overLimit.push(rejection);
        } else {
            sentences.push(`Couldn't add ${rejection.name}: ${rejectionReason(rejection.reason)}.`);
        }
    }
    const [first] = overLimit;
    if (first !== undefined) {
        const files = overLimit.length === 1 ? first.name : `${overLimit.length.toString()} files`;
        sentences.push(`Couldn't add ${files}: a message can have up to ${first.limit.toString()} attachments.`);
    }
    return sentences.join(" ");
}

export function composerErrorMessage(error: string, attachmentState: ComposerAttachmentStore["state"]): string {
    if (error.length > 0) {
        return error;
    }
    return attachmentState.kind === "rejected" ? attachmentRejectionMessage(attachmentState.rejections) : "";
}

/**
 * The single surface for everything a composer reports above its input box: a send
 * or attachment failure, the connection state, or a standing status line. The pane
 * renders it at the top of the queue/interaction stack when one is present; the
 * composer renders it inside its form, floating over the log, when nothing is.
 */
export function ComposerNoticeSlot({
    connectionNotice,
    errorMessage,
    placement,
    statusMessage,
}: {
    readonly connectionNotice?: ((inline: boolean) => ReactNode) | undefined;
    readonly errorMessage: string;
    readonly placement: ComposerNoticePlacement;
    readonly statusMessage?: string | undefined;
}) {
    const notice = useRef<HTMLDivElement>(null);
    const connection = connectionNotice?.(errorMessage.length > 0);
    const showComposerNotice = errorMessage.length > 0 || connection !== undefined || statusMessage !== undefined;
    // A send failure owns the headline, but a standing status (such as unrestored
    // attachments) still explains the draft: keep it as the error alert's detail
    // instead of letting the failure branch hide it.
    const errorDetail =
        statusMessage === undefined ? (
            connection
        ) : (
            <>
                {connection}
                <span className="block">{statusMessage}</span>
            </>
        );
    useComposerNoticeLayout(notice, showComposerNotice && placement === "overlay");
    if (!showComposerNotice) {
        return null;
    }
    return (
        <div
            className={
                placement === "in-flow"
                    ? // Same column width as the composer form and the queue card, so
                      // the stacked notice keeps their gutters at every breakpoint.
                      // relative z-[1] matches the queue card: the log wrapper is
                      // positioned, so without a layer of its own the slot's top
                      // seam would let scrolling log content paint through it.
                      "relative z-[1] mx-auto mb-2 w-full min-w-0 px-3 sm:w-[min(920px,calc(100%-24px))] sm:px-0"
                    : // The form's mobile gutters live in its padding, which an
                      // absolute slot would span edge to edge; keep the notice
                      // aligned with the composer card and the queue card.
                      "absolute inset-x-3 bottom-[calc(100%+8px)] z-10 sm:inset-x-0"
            }
            data-notice-placement={placement}
            ref={notice}
        >
            {errorMessage.length > 0 ? (
                <MortyAlert description={errorDetail}>{errorMessage}</MortyAlert>
            ) : connection !== undefined ? (
                connection
            ) : statusMessage !== undefined ? (
                <MortyAlert tone="neutral">{statusMessage}</MortyAlert>
            ) : null}
        </div>
    );
}
