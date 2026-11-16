import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from "react";

const dialogBodyEdgeThresholdPx = 4;

type ClippedEdges = {
    readonly bottom: boolean;
    readonly top: boolean;
};

function clippedDialogBodyEdges(element: HTMLElement): ClippedEdges {
    return {
        top: element.scrollTop > dialogBodyEdgeThresholdPx,
        bottom: element.scrollHeight - element.scrollTop - element.clientHeight > dialogBodyEdgeThresholdPx,
    };
}

export function useDialogBodyClippedEdges(bodyScrollRef: RefObject<HTMLDivElement | null>): {
    readonly bodyEdges: ClippedEdges;
    readonly syncBodyEdges: () => void;
} {
    const [bodyEdges, setBodyEdges] = useState<ClippedEdges>({ top: false, bottom: false });
    const syncBodyEdges = useCallback(() => {
        const element = bodyScrollRef.current;
        if (element === null) {
            return;
        }
        const next = clippedDialogBodyEdges(element);
        setBodyEdges((current) => (current.top === next.top && current.bottom === next.bottom ? current : next));
    }, [bodyScrollRef]);
    useLayoutEffect(() => {
        syncBodyEdges();
    });
    useEffect(() => {
        const element = bodyScrollRef.current;
        if (element === null) {
            return;
        }
        const resizes = new ResizeObserver(syncBodyEdges);
        resizes.observe(element);
        const observeChildren = () => {
            for (const child of element.children) {
                if (child instanceof HTMLElement) {
                    resizes.observe(child);
                }
            }
        };
        observeChildren();
        const mutations = new MutationObserver(() => {
            syncBodyEdges();
            observeChildren();
        });
        mutations.observe(element, { characterData: true, childList: true, subtree: true });
        return () => {
            mutations.disconnect();
            resizes.disconnect();
        };
    }, [bodyScrollRef, syncBodyEdges]);
    return { bodyEdges, syncBodyEdges };
}
