import { GitFork, LoaderCircle } from "lucide-react";
import { cn } from "../../lib/utils.ts";
import { replyActionButtonClassName } from "./response-copy-button.tsx";

export function ForkSessionButton({
    forking,
    disabled,
    onFork,
}: {
    readonly forking: boolean;
    readonly disabled: boolean;
    readonly onFork: () => void;
}) {
    return (
        <button
            aria-busy={forking}
            aria-label="Fork session"
            // Touch targets extend past the icon; the extra gap keeps them from overlapping the copy button's.
            className={cn(
                replyActionButtonClassName,
                "ml-1 disabled:pointer-events-none disabled:opacity-50 aria-busy:opacity-100",
            )}
            disabled={disabled}
            onClick={onFork}
            title="Fork session"
            type="button"
        >
            {forking ? (
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
                <GitFork aria-hidden="true" className="size-3.5" />
            )}
        </button>
    );
}
