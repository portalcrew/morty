import { type ReactNode, useRef } from "react";
import type { ComposerAttachmentStore } from "../../view-models/chat/composer-attachment-store.ts";
import { MortyAlert } from "../ui/morty-alert.tsx";
import { useComposerNoticeLayout } from "../utils/use-composer-notice-layout.ts";

export type ComposerNoticePlacement = "overlay" | "in-flow";

export function composerErrorMessage(error: string, attachmentState: ComposerAttachmentStore["state"]): string {
    return error.length > 0 ? error : attachmentState.kind === "failed" ? attachmentState.message : "";
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
