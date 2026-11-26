import { type RefObject, useLayoutEffect } from "react";

/**
 * Gives wrapped buttons inside a row the block radius. A single-line button stays
 * a pill; once its copy wraps past one line (two lines or more) the button
 * reads as a block and takes the 16px radius (`rounded-md` on this repo's scale)
 * instead of the 20px pill. The two radius classes swap exclusively because
 * `rounded-md` sorts before `rounded-lg` and would otherwise lose the cascade.
 */
export function useWrappedButtonRadius(rowRef: RefObject<HTMLDivElement | null>): void {
    useLayoutEffect(() => {
        const row = rowRef.current;
        if (row === null) {
            return;
        }
        const sync = () => {
            for (const button of row.querySelectorAll("button")) {
                // One line is about 33px, or the min-height when larger (44px phone touch targets);
                // two lines are about 49px.
                const minHeight = Number.parseFloat(getComputedStyle(button).minHeight) || 0;
                const wrapped = button.getBoundingClientRect().height > Math.max(40, minHeight);
                button.classList.toggle("rounded-md", wrapped);
                button.classList.toggle("rounded-lg", !wrapped);
            }
        };
        const resizes = new ResizeObserver(sync);
        resizes.observe(row);
        sync();
        return () => resizes.disconnect();
    });
}
