import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

const TOP_EDGE_PIXELS = 80;

export function useLoadMoreOnScroll({
    container,
    hasMore,
    loading,
    onLoadMore,
    revision,
}: {
    readonly container: RefObject<HTMLElement | null>;
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly onLoadMore: (signal: AbortSignal) => Promise<void>;
    readonly revision: number;
}): { readonly checkScrollEdge: (element: HTMLElement, requireLayout?: boolean) => void } {
    const anchor = useRef<{ readonly height: number; readonly top: number } | null>(null);
    const pending = useRef(false);
    const controller = useRef<AbortController | null>(null);
    const revisionRef = useRef(revision);
    revisionRef.current = revision;
    const requestRef = useRef<() => void>(() => undefined);

    useEffect(
        () => () => {
            controller.current?.abort();
        },
        [],
    );

    requestRef.current = () => {
        const element = container.current;
        if (element === null || pending.current || !hasMore || loading) {
            return;
        }
        pending.current = true;
        anchor.current = { height: element.scrollHeight, top: element.scrollTop };
        const startRevision = revisionRef.current;
        const requestController = new AbortController();
        controller.current = requestController;
        void onLoadMore(requestController.signal)
            .catch(() => {
                anchor.current = null;
            })
            .finally(() => {
                // Keep the anchor only when the load prepended content (the
                // revision moved); otherwise a later unrelated commit would
                // restore a stale scroll offset.
                if (revisionRef.current === startRevision) {
                    anchor.current = null;
                }
                pending.current = false;
            });
    };

    const checkScrollEdge = useCallback((element: HTMLElement, requireLayout = false) => {
        if (element.scrollTop > TOP_EDGE_PIXELS) {
            return;
        }
        if (requireLayout && element.clientHeight <= 0) {
            return;
        }
        requestRef.current();
    }, []);

    useLayoutEffect(() => {
        const element = container.current;
        if (element === null) {
            return;
        }
        const request = (): void => {
            const current = container.current;
            if (current !== null) {
                checkScrollEdge(current, false);
            }
        };
        element.addEventListener("scroll", request, { passive: true });
        return () => element.removeEventListener("scroll", request);
    });

    // A container already resting at the top edge emits no further scroll
    // events, so re-check the edge after mount and whenever the rendered
    // content or availability changes. The frame lets the browser settle
    // pending layout and programmatic scrolls (for example, following the
    // latest message when a conversation first renders) before measuring.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The edge check reads current props through a ref.
    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            const element = container.current;
            if (element !== null) {
                checkScrollEdge(element, true);
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [checkScrollEdge, container, hasMore, revision]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: Restore the scroll offset after the prepended content commits.
    useLayoutEffect(() => {
        const element = container.current;
        const saved = anchor.current;
        if (element !== null && saved !== null) {
            element.scrollTop = saved.top + (element.scrollHeight - saved.height);
            anchor.current = null;
        }
    }, [container, revision]);

    return { checkScrollEdge };
}
