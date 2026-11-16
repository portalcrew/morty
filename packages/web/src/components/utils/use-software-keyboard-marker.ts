import { type RefCallback, useCallback } from "react";

const markerAttribute = "data-software-keyboard";
const keyboardHeightThresholdPx = 120;
/** Input types that take focus without opening a software keyboard. */
const keylessInputTypes = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
]);

type ClosedViewport = { readonly width: number; readonly height: number };

/**
 * The tallest visible height seen per window and width. It is shared across mounts and only grows, so
 * another field's keyboard, a remount, or a blur during the closing animation cannot lower it. A width change
 * (rotation) starts over.
 */
const closedViewports = new WeakMap<Window, ClosedViewport>();

function opensSoftwareKeyboard(element: Element | null): boolean {
    return (
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLInputElement && !keylessInputTypes.has(element.type))
    );
}

/**
 * Attaches to a container of text fields, such as the composer form or the phone rename bar, and marks it
 * `data-software-keyboard="open"` while a field inside it has focus and a software keyboard covers the bottom edge.
 *
 * iOS keeps reporting the full safe-area inset while the keyboard covers the home indicator, so a safe-area margin
 * or padding at the bottom edge would float the container above the keyboard. Neither a coarse pointer nor focus
 * proves the keyboard is visible, because a Bluetooth keyboard has both, so this compares the visible height with
 * the tallest height seen before. A host that never shrinks its viewport leaves the marker off and the safe-area
 * spacing in place. The marker is a DOM attribute, so the layout flips without re-rendering. Listeners are bound and
 * released with the container element.
 */
export function useSoftwareKeyboardMarker(): RefCallback<HTMLElement> {
    return useCallback((container) => {
        const view = container?.ownerDocument.defaultView;
        if (container === null || view === null || view === undefined) {
            return;
        }
        const visible = view.visualViewport;
        const sync = () => {
            const width = view.innerWidth;
            const height = visible?.height ?? view.innerHeight;
            const known = closedViewports.get(view);
            const closed =
                known?.width === width ? { width, height: Math.max(known.height, height) } : { width, height };
            closedViewports.set(view, closed);
            const active = container.ownerDocument.activeElement;
            const typing = opensSoftwareKeyboard(active) && container.contains(active);
            if (typing && height < closed.height - keyboardHeightThresholdPx) {
                container.setAttribute(markerAttribute, "open");
            } else {
                container.removeAttribute(markerAttribute);
            }
        };
        const onFocusOut = () => container.removeAttribute(markerAttribute);
        container.addEventListener("focusin", sync);
        container.addEventListener("focusout", onFocusOut);
        view.addEventListener("resize", sync);
        visible?.addEventListener("resize", sync);
        sync();
        return () => {
            container.removeEventListener("focusin", sync);
            container.removeEventListener("focusout", onFocusOut);
            view.removeEventListener("resize", sync);
            visible?.removeEventListener("resize", sync);
            container.removeAttribute(markerAttribute);
        };
    }, []);
}
