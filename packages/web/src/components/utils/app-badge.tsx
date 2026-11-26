import { useEffect } from "react";

/** Best effort: a browser may refuse a badge, as iOS does without notification permission, and the title still counts. */
export function AppBadge({ count }: { readonly count: number }) {
    useEffect(() => {
        if (!("setAppBadge" in navigator)) {
            return;
        }
        const shown = count === 0 ? navigator.clearAppBadge() : navigator.setAppBadge(count);
        shown.catch(() => undefined);
    }, [count]);
    useEffect(
        () => () => {
            if ("clearAppBadge" in navigator) {
                navigator.clearAppBadge().catch(() => undefined);
            }
        },
        [],
    );
    return null;
}
