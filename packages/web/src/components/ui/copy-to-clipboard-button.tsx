import { Copy } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { Button } from "./cloud-button.tsx";
import { useToast } from "./toast.tsx";

type CopyFeedback =
    | { readonly kind: "idle" }
    | { readonly kind: "confirming"; readonly attempt: number }
    | { readonly kind: "confirmed"; readonly attempt: number };

/**
 * A copy affordance for a single text value with copied/failed feedback
 * reported through the toast host. Pure UI: callers own the text and labels;
 * the failure toast tells the user to copy manually when the write is denied.
 */
export function CopyToClipboardButton({
    value,
    label,
    failureToast,
    successToast,
    successContent,
    idleContent,
    copiedContent,
    children,
    className = "",
    size,
    variant = "primary",
}: {
    readonly value: string;
    readonly label: string;
    readonly failureToast: { readonly description: string; readonly title: string };
    readonly successToast?: { readonly description?: string; readonly title: string };
    /** Inline feedback for a next step that should stay visible instead of a toast. */
    readonly successContent?: ReactNode;
    readonly idleContent?: ReactNode;
    readonly copiedContent?: ReactNode;
    readonly children?: ReactNode;
    readonly className?: string;
    readonly size?: ComponentProps<typeof Button>["size"];
    readonly variant?: ComponentProps<typeof Button>["variant"];
}) {
    const [feedback, setFeedback] = useState<CopyFeedback>({ kind: "idle" });
    const showToast = useToast();
    const confirming = feedback.kind === "confirming";
    const ariaLabel = confirming ? "Copied" : label;
    const finishConfirmation = (attempt: number) => {
        setFeedback((current) =>
            current.kind === "confirming" && current.attempt === attempt ? { kind: "confirmed", attempt } : current,
        );
    };
    const onClick = () => {
        if (navigator.clipboard === undefined) {
            showToast({ ...failureToast, variant: "error" });
            return;
        }
        void navigator.clipboard.writeText(value).then(
            () => {
                setFeedback((current) => ({
                    kind: "confirming",
                    attempt: current.kind === "idle" ? 1 : current.attempt + 1,
                }));
                if (successContent === undefined && successToast !== undefined) {
                    showToast({ ...successToast, variant: "success" });
                }
            },
            () => showToast({ ...failureToast, variant: "error" }),
        );
    };

    if (children !== undefined) {
        return (
            <>
                <Button
                    aria-label={ariaLabel}
                    className={className}
                    onClick={onClick}
                    onAnimationEnd={(event) => {
                        if (feedback.kind === "confirming" && event.animationName === "copy-confirmation") {
                            finishConfirmation(feedback.attempt);
                        }
                    }}
                    {...(size !== undefined ? { size } : {})}
                    title={label}
                    variant={variant}
                >
                    {confirming ? (
                        <span
                            className="inline-flex animate-copy-confirmation items-center gap-2"
                            key={feedback.attempt}
                        >
                            {copiedContent ?? "Copied"}
                        </span>
                    ) : (
                        children
                    )}
                </Button>
                {feedback.kind === "idle" ? idleContent : successContent}
            </>
        );
    }

    return (
        <button
            aria-label={ariaLabel}
            onAnimationEnd={(event) => {
                if (feedback.kind === "confirming" && event.animationName === "copy-confirmation") {
                    finishConfirmation(feedback.attempt);
                }
            }}
            title={label}
            type="button"
            onClick={onClick}
        >
            <span
                className={confirming ? "inline-flex animate-copy-confirmation" : "inline-flex"}
                key={confirming ? feedback.attempt : "idle"}
            >
                <Copy aria-hidden="true" className="size-4" />
            </span>
        </button>
    );
}
