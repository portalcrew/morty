import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/cloud-button.tsx";

/** Copies a sharing link and owns the dialog-local confirmation and fallback state. */
export function CopyLinkButton({
    className,
    url,
    urlClassName,
    copyLabel = "Copy link",
    subject = "link",
}: {
    readonly className?: string;
    readonly url: string;
    readonly urlClassName?: string;
    readonly copyLabel?: string;
    /** What the copied text is, as the manual-copy fallback names it. */
    readonly subject?: string;
}) {
    const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
    return (
        <div className={cn("space-y-3 text-left", className)}>
            <p
                className={cn(
                    "break-all rounded-lg border-[0.5px] border-black/5 bg-white px-4 py-3 font-mono text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]",
                    urlClassName,
                )}
            >
                {url}
            </p>
            <Button
                variant="primary"
                onClick={() => {
                    if (navigator.clipboard === undefined) {
                        setCopy("failed");
                        return;
                    }
                    void navigator.clipboard.writeText(url).then(
                        () => setCopy("copied"),
                        () => setCopy("failed"),
                    );
                }}
            >
                {copy === "copied" ? (
                    <Check aria-hidden="true" className="size-4" />
                ) : (
                    <Copy aria-hidden="true" className="size-4" />
                )}
                <span>{copy === "copied" ? "Copied" : copyLabel}</span>
            </Button>
            {copy === "failed" && (
                <p className="text-xs text-muted-foreground" role="alert">
                    Could not copy the {subject}. Copy it manually from above.
                </p>
            )}
        </div>
    );
}
