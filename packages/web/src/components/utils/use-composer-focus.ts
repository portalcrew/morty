import { type RefCallback, type RefObject, useCallback, useEffect } from "react";

// The draft and its new Session render different composer instances in the same workspace, and a followed fork
// replaces the Session it came from. Keep only DOM focus and selection across that replacement, scoped to the owning
// workspace.
const composerFocus = new WeakMap<object, { readonly start: number; readonly end: number } | "end">();

export function handComposerFocus(focusScope: object): void {
    composerFocus.set(focusScope, "end");
}

// A composer that cannot take focus yet, such as a fork's while its Session opens, leaves it for when it can.
function takeComposerFocus(element: HTMLTextAreaElement, focusScope: object): void {
    if (element.disabled) {
        return;
    }
    const selection = composerFocus.get(focusScope);
    composerFocus.delete(focusScope);
    if (selection === undefined || element.ownerDocument.activeElement !== element.ownerDocument.body) {
        return;
    }
    element.focus({ preventScroll: true });
    if (selection === "end") {
        element.setSelectionRange(element.value.length, element.value.length);
    } else {
        element.setSelectionRange(selection.start, selection.end);
    }
}

export function useComposerFocus(
    textarea: RefObject<HTMLTextAreaElement | null>,
    disabled: boolean,
    focusScope?: object,
): RefCallback<HTMLTextAreaElement> {
    useEffect(() => {
        if (!disabled && textarea.current !== null && focusScope !== undefined) {
            takeComposerFocus(textarea.current, focusScope);
        }
    }, [disabled, focusScope, textarea]);
    return useCallback(
        (element) => {
            textarea.current = element;
            if (element === null) {
                return;
            }
            if (focusScope !== undefined) {
                takeComposerFocus(element, focusScope);
            }
            return () => {
                if (focusScope !== undefined && element.ownerDocument.activeElement === element) {
                    composerFocus.set(focusScope, { start: element.selectionStart, end: element.selectionEnd });
                }
                textarea.current = null;
            };
        },
        [focusScope, textarea],
    );
}
