import { Archive, Check, Copy, type LucideIcon, RefreshCw, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { dataTestId } from "../../data-testid.ts";
import { CopyToClipboardButton } from "../ui/copy-to-clipboard-button.tsx";
import { LinkButton } from "../ui/link-button.tsx";
import { MortyAlert, type MortyAlertTone } from "../ui/morty-alert.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import type { ConnectionFeedback } from "./execution-context.ts";

type VisibleFeedback = Exclude<ConnectionFeedback, { readonly kind: "hidden" }>;
function noticeTestId(feedback: ConnectionFeedback): string {
    return feedback.kind === "closed"
        ? dataTestId.sessionClosedNotice
        : feedback.kind === "reconnecting" || feedback.kind === "attempting"
          ? dataTestId.sessionReconnectStatus
          : dataTestId.sessionReconnectNotice;
}

/**
 * Surface for a connection state, matching the tone rules shared by every other
 * notice in the product: failures read as errors, everything else is neutral.
 */
function noticeTone(feedback: VisibleFeedback): MortyAlertTone {
    return feedback.kind === "failed" || feedback.kind === "action-required" ? "error" : "neutral";
}

/** The leading icon names the connection state, so it can stand in for the tone's default icon. */
function noticeIcon(feedback: VisibleFeedback): LucideIcon | undefined {
    if (feedback.kind === "closed") {
        return Archive;
    }
    if (feedback.kind === "attempting") {
        return RefreshCw;
    }
    return feedback.kind === "retrying" || feedback.kind === "waiting" || feedback.kind === "reconnecting"
        ? WifiOff
        : undefined;
}

function RetryAction({ className, onClick }: { readonly className: string; readonly onClick: () => void }) {
    return (
        <LinkButton className={className} onClick={onClick}>
            Retry now
        </LinkButton>
    );
}

/**
 * The restart command on its own row: monospace and unbroken so it can be typed exactly,
 * with a copy action for when Morty is open on that computer.
 */
function RestartCommand({ command }: { readonly command: string }) {
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 font-normal">
            <span>After a restart, run</span>
            <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1">
                <ScrollArea
                    className="max-w-full shrink rounded-md bg-muted"
                    orientation="horizontal"
                    viewportClassName="max-w-full"
                >
                    <code className="whitespace-nowrap px-1.5 py-0.5 font-mono text-[11px] leading-4 text-foreground">
                        {command}
                    </code>
                </ScrollArea>
                <CopyToClipboardButton
                    className="w-7 px-0"
                    copiedContent={<Check aria-hidden="true" className="size-3.5" />}
                    failureToast={{ description: "Select the command and copy it manually.", title: "Could not copy" }}
                    label="Copy command"
                    size="xs"
                    successToast={{ description: "Run it in a terminal on that computer.", title: "Command copied" }}
                    value={command}
                    variant="ghost"
                >
                    <Copy aria-hidden="true" className="size-3.5" />
                </CopyToClipboardButton>
            </span>
        </div>
    );
}

function retryButton(feedback: VisibleFeedback, onRetryNow: () => void, className: string): ReactNode {
    if (feedback.kind !== "retrying" && feedback.kind !== "failed") {
        return null;
    }
    return <RetryAction className={className} onClick={onRetryNow} />;
}

function countdown(feedback: VisibleFeedback): ReactNode {
    if (feedback.kind !== "retrying" || feedback.remainingSeconds === null) {
        return null;
    }
    return <span className="tabular-nums">Retrying in {feedback.remainingSeconds} s</span>;
}

export function ConnectionNotice({
    feedback,
    footer,
    inline = false,
    onRetryNow,
}: {
    readonly feedback: ConnectionFeedback;
    /**
     * Single muted status line for embedding inside another notice: the host
     * notice already carries the headline, so the title and block chrome here
     * would only repeat it and stack a second hierarchy inside the first.
     */
    readonly inline?: boolean;
    /** Extra action line, such as switching to another online computer. */
    readonly footer?: ReactNode;
    readonly onRetryNow: () => void;
}) {
    if (feedback.kind === "hidden") {
        return null;
    }
    // No text size here: the row already sets text-12, and passing a custom text-*
    // token through LinkButton's tailwind-merge would evict its text-primary color.
    //
    // The action keeps a 20px box at every breakpoint, because a 44px box inside
    // the detail row stretched that line and opened a 16px gap under the headline.
    // Phones still get the 44px touch target, extended by a transparent overlay
    // instead of by visual height. The inline variant sits inside another alert's
    // description and keeps exactly the box it always had.
    const actionClassName = inline
        ? "min-h-5"
        : "relative min-h-5 before:absolute before:inset-x-0 before:top-1/2 before:h-11 before:-translate-y-1/2 before:content-[''] sm:before:hidden";
    const retry = retryButton(feedback, onRetryNow, actionClassName);
    const testId = noticeTestId(feedback);
    const restart =
        (feedback.kind === "waiting" || feedback.kind === "retrying") && feedback.restartCommand !== null ? (
            <RestartCommand command={feedback.restartCommand} />
        ) : null;

    // The waiting state reads as a compact chip: title only, in a
    // button-like shape on the chat surface so it sits left-aligned with the
    // composer instead of spanning the pane. The trailing ellipsis animates
    // dot by dot; the clipped span keeps its full width so layout never shifts.
    if (feedback.kind === "waiting" && !inline) {
        const title = feedback.title.endsWith("…") ? feedback.title.slice(0, -1) : feedback.title;
        const chip = (
            <div
                className="flex h-9 w-fit items-center rounded-[24px] bg-surface-elevated px-4 text-12 font-medium text-morty-text-2"
                data-testid={testId}
            >
                <span>{title}</span>
                {title !== feedback.title && (
                    // Three periods, not the single ellipsis glyph: the clip-path
                    // thirds line up with each period's advance, so the loop
                    // starts at exactly one dot.
                    <span aria-hidden="true" className="animate-reconnect-ellipsis motion-reduce:animate-none">
                        ...
                    </span>
                )}
            </div>
        );
        // The chip has no description slot, so an extra action the host supplies (such
        // as switching to another online computer) stacks under it instead of vanishing.
        return footer === undefined ? (
            chip
        ) : (
            <div className="flex min-w-0 flex-col items-start">
                {chip}
                {footer}
            </div>
        );
    }

    if (inline) {
        const line = (
            <div
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-12 font-normal"
                data-testid={testId}
            >
                <span className="min-w-0">
                    {feedback.kind === "closed" ? "The session is closed." : feedback.description}
                </span>
                {countdown(feedback)}
                {retry}
            </div>
        );
        // The host's own action (switching to another online computer) is part of the
        // recovery the inline line describes, so it stays reachable inside the alert.
        if (restart !== null) {
            return (
                <div className="flex min-w-0 flex-col items-start gap-y-1">
                    {line}
                    {restart}
                    {footer}
                </div>
            );
        }
        return footer === undefined ? (
            line
        ) : (
            <div className="flex min-w-0 flex-col items-start">
                {line}
                {footer}
            </div>
        );
    }

    // The host alert owns the surface, the live region and the headline: this
    // component fills its two slots instead of stacking its own heading block
    // inside the alert's, so connection states read exactly like every other
    // notice (tone ink for the headline, muted text for the detail line).
    const detail = (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-normal">
            <span className="min-w-0">{feedback.description}</span>
            {countdown(feedback)}
            {retry}
        </div>
    );
    return (
        <MortyAlert
            className="rounded-[20px]"
            description={
                restart !== null ? (
                    <div className="grid min-w-0 gap-y-1">
                        {detail}
                        {restart}
                        {footer}
                    </div>
                ) : footer === undefined ? (
                    detail
                ) : (
                    <>
                        {detail}
                        {footer}
                    </>
                )
            }
            icon={noticeIcon(feedback)}
            iconClassName={feedback.kind === "attempting" ? "animate-spin motion-reduce:animate-none" : undefined}
            testId={testId}
            tone={noticeTone(feedback)}
        >
            {feedback.kind === "closed" ? "The session is closed." : feedback.title}
        </MortyAlert>
    );
}
