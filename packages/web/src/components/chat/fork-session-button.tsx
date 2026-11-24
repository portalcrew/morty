import { GitFork, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "../../lib/utils.ts";
import { handComposerFocus } from "../utils/use-composer-focus.ts";
import { replyActionButtonClassName } from "./response-copy-button.tsx";

export function ForkSessionButton({
    focusScope,
    forking,
    disabled,
    onFork,
}: {
    readonly focusScope: object;
    readonly forking: boolean;
    readonly disabled: boolean;
    readonly onFork: () => void;
}) {
    const keyboardFork = useRef(false);
    useEffect(() => {
        if (!forking) {
            keyboardFork.current = false;
        }
    }, [forking]);
    // A fork the workspace follows replaces this pane while the fork is still in progress here; keyboard focus moves on
    // to the fork's composer instead of falling to the page.
    const attach = useCallback(
        (button: HTMLButtonElement | null) => {
            if (button === null) {
                return;
            }
            return () => {
                if (keyboardFork.current && button.ownerDocument.activeElement === button) {
                    handComposerFocus(focusScope);
                }
            };
        },
        [focusScope],
    );
    return (
        <button
            aria-busy={forking}
            aria-label="Fork session"
            // Touch targets extend past the icon; the extra gap keeps them from overlapping the copy button's.
            className={cn(
                replyActionButtonClassName,
                "ml-1 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-busy:opacity-100",
            )}
            // Unlike `disabled`, this keeps keyboard focus on the button while the fork is in progress.
            aria-disabled={disabled || undefined}
            onClick={
                disabled
                    ? undefined
                    : (event) => {
                          keyboardFork.current = event.currentTarget.matches(":focus-visible");
                          onFork();
                      }
            }
            ref={attach}
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
