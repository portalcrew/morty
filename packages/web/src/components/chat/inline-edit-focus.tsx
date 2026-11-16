import { type ReactNode, useCallback, useRef } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * Keeps focus across an inline edit that swaps a control for its editor and back. When the edit ends, focus that was
 * in the editor returns to the control instead of falling to the page; focus the user moved elsewhere stays there.
 * The state is DOM-ephemeral: it only follows where focus is.
 */
export function InlineEditFocus({
    control,
    editing,
    editor,
    editorClassName,
    label,
}: {
    readonly control: (ref: (node: HTMLElement | null) => void) => ReactNode;
    readonly editing: boolean;
    readonly editor: ReactNode;
    readonly editorClassName: string;
    readonly label: string;
}) {
    const returnFocus = useRef(false);
    const controlRef = useCallback((node: HTMLElement | null) => {
        if (node !== null && returnFocus.current) {
            returnFocus.current = false;
            node.focus();
        }
    }, []);
    if (!editing) {
        return control(controlRef);
    }
    return (
        <fieldset
            aria-label={label}
            className={cn("m-0 min-w-0 border-0 p-0", editorClassName)}
            onBlur={(event) => {
                // A control disabled while saving drops focus to nothing; only focus moved to another element leaves.
                if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
                    returnFocus.current = false;
                }
            }}
            onFocus={() => {
                returnFocus.current = true;
            }}
        >
            {editor}
        </fieldset>
    );
}
