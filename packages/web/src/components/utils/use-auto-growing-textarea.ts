import { type RefObject, useCallback, useLayoutEffect } from "react";

/**
 * Sizes a textarea to its content. A surrounding scroll region owns the height
 * cap and scrollbar, so the textarea itself never keeps a second native scrollport.
 * Running before paint avoids a one-frame jump.
 */
export function useAutoGrowingTextarea(
    textarea: RefObject<HTMLTextAreaElement | null>,
    content: string,
    scrollViewport?: RefObject<HTMLElement | null>,
): void {
    const resize = useCallback(
        (element: HTMLTextAreaElement) => {
            // An empty box shows only its placeholder, whose start must stay in view.
            const followsCaret =
                element.value.length > 0 &&
                element.selectionStart === element.value.length &&
                element.selectionEnd === element.value.length;
            element.style.height = "auto";
            element.style.height = `${element.scrollHeight.toString()}px`;
            const viewport = scrollViewport?.current;
            if (followsCaret && viewport !== undefined && viewport !== null) {
                viewport.scrollTop = viewport.scrollHeight;
            }
        },
        [scrollViewport],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: content is the deliberate re-measure trigger.
    useLayoutEffect(() => {
        const element = textarea.current;
        if (element !== null) {
            resize(element);
        }
    }, [content, resize, textarea]);

    useLayoutEffect(() => {
        const element = textarea.current;
        if (element === null || typeof ResizeObserver === "undefined") {
            return;
        }
        let width = element.clientWidth;
        const observer = new ResizeObserver(() => {
            const nextWidth = element.clientWidth;
            if (nextWidth === width) {
                return;
            }
            width = nextWidth;
            resize(element);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [resize, textarea]);
}
