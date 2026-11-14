import { ArrowDown } from "lucide-react";
import {
    type ComponentPropsWithoutRef,
    type RefObject,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "../ui/cloud-button.tsx";
import { LoadingWave } from "../ui/loading-wave.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { useLoadMoreOnScroll } from "./load-more-trigger.tsx";

type FollowLatestScrollAreaProps = Omit<ComponentPropsWithoutRef<"div">, "ref" | "dir"> & {
    /** Callers that need the element pass their ref; omitted, the area owns it. */
    readonly container?: RefObject<HTMLDivElement | null>;
    /**
     * Requests an older page when the top edge is reached. Providing it wires
     * top-edge pagination into the area so callers never hold scroll refs.
     */
    readonly loadOlder?: {
        readonly hasMore: boolean;
        readonly loading: boolean;
        readonly onLoadMore: (signal: AbortSignal) => Promise<void>;
        readonly revision: number;
    };
    readonly followThreshold?: number | undefined;
    /**
     * Re-arms following whenever this value changes: the container scrolls
     * back to its latest content even if the user had scrolled away. Purely a
     * scroll concern; callers decide what a new value means. `null` never
     * re-arms.
     */
    readonly followRevision: number | null;
    /** Shows a floating jump control while the latest content is out of view. */
    readonly jumpToLatest?: {
        readonly label: string;
        readonly working: boolean;
    };
    readonly showTopFade?: boolean;
    /** Uses the product scrollbar while keeping this component's scroll ref on its viewport. */
    readonly useProductScrollbar?: boolean;
    readonly viewportClassName?: string;
};

/**
 * Keeps a scroll container pinned to its latest content until the user moves
 * away from the bottom. It has no knowledge of the content or its workflow.
 */
export function FollowLatestScrollArea({
    container,
    loadOlder,
    followThreshold = 1,
    followRevision = null,
    jumpToLatest,
    showTopFade = false,
    useProductScrollbar = false,
    viewportClassName,
    className,
    onScroll,
    role,
    "aria-label": ariaLabel,
    ...props
}: FollowLatestScrollAreaProps) {
    const owned = useRef<HTMLDivElement | null>(null);
    const scrollArea = container ?? owned;
    const following = useRef(true);
    const lastTop = useRef(0);
    const pagination = useLoadMoreOnScroll({
        container: scrollArea,
        hasMore: loadOlder?.hasMore ?? false,
        loading: loadOlder?.loading ?? false,
        onLoadMore: loadOlder?.onLoadMore ?? (async () => {}),
        revision: loadOlder?.revision ?? 0,
    });
    const [topFadeVisible, setTopFadeVisible] = useState(false);
    const [jumpToLatestVisible, setJumpToLatestVisible] = useState(false);
    const jumpToLatestEnabled = jumpToLatest !== undefined;
    const jumpToLatestWorking = jumpToLatest?.working === true;
    // Visibility can use a forgiving threshold. Following must require the true
    // bottom: otherwise a scroll that merely enters the button threshold flips
    // this state and the next render snaps the user to the end.
    const isAtLatest = (element: HTMLDivElement) =>
        element.scrollHeight - element.scrollTop - element.clientHeight <= 1;

    const syncScrollChrome = useCallback(
        (element: HTMLDivElement) => {
            setJumpToLatestVisible(
                jumpToLatestEnabled &&
                    element.scrollHeight - element.scrollTop - element.clientHeight > followThreshold,
            );
            if (showTopFade) {
                setTopFadeVisible(element.scrollTop > 4);
            }
        },
        [followThreshold, jumpToLatestEnabled, showTopFade],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: followRevision is the deliberate re-arm trigger.
    useLayoutEffect(() => {
        following.current = true;
        const element = scrollArea.current;
        if (element !== null) {
            element.scrollTop = element.scrollHeight;
            lastTop.current = element.scrollTop;
            syncScrollChrome(element);
        }
    }, [container, followRevision]);
    useLayoutEffect(() => {
        const element = scrollArea.current;
        if (following.current && element !== null) {
            element.scrollTop = element.scrollHeight;
            lastTop.current = element.scrollTop;
        }
        if (element !== null) {
            syncScrollChrome(element);
        }
        if (following.current && element !== null) {
            following.current = isAtLatest(element);
        }
    });

    useEffect(() => {
        const element = scrollArea.current;
        if (element === null) {
            return;
        }
        const keepLatestVisible = () => {
            if (following.current) {
                element.scrollTop = element.scrollHeight;
                lastTop.current = element.scrollTop;
            }
            syncScrollChrome(element);
        };
        // Content changes (streaming, replacing branches) and pure layout
        // changes (window resizing, images loading, reflowed text) both move
        // the latest content; watch both so following survives each.
        const mutations = new MutationObserver(keepLatestVisible);
        mutations.observe(element, { characterData: true, childList: true, subtree: true });
        const resizes = new ResizeObserver(keepLatestVisible);
        resizes.observe(element);
        for (const child of element.children) {
            resizes.observe(child);
        }
        return () => {
            mutations.disconnect();
            resizes.disconnect();
        };
    }, [syncScrollChrome, scrollArea.current]);

    const handleScroll: NonNullable<typeof onScroll> = (event) => {
        const element = event.currentTarget;
        const top = element.scrollTop;
        const distanceFromLatest = element.scrollHeight - top - element.clientHeight;
        // Any upward move away from the bottom is the user leaving the latest content, even when the
        // whole overflow fits inside the follow threshold; without this, a short conversation pins
        // every user scroll back to the bottom. Programmatic pins and shrinking content land at the
        // bottom (distance 0), so they keep following. Only the true bottom re-arms following; the
        // jump control's wider threshold is only for deciding when to show its affordance.
        if (top < lastTop.current && distanceFromLatest > 0) {
            following.current = false;
        } else if (isAtLatest(element)) {
            following.current = true;
        }
        lastTop.current = top;
        syncScrollChrome(element);
        if (loadOlder !== undefined) {
            pagination.checkScrollEdge(element, false);
        }
        onScroll?.(event);
    };
    const area = useProductScrollbar ? (
        <ScrollArea
            {...props}
            className={className}
            onViewportScroll={handleScroll}
            viewportClassName={cn("h-full", viewportClassName)}
            viewportLabel={ariaLabel}
            viewportRef={scrollArea}
            viewportRole={role}
        />
    ) : (
        <div
            {...{ ...props, role, "aria-label": ariaLabel }}
            className={className}
            onScroll={handleScroll}
            ref={scrollArea}
        />
    );

    if (!showTopFade && jumpToLatest === undefined) {
        return area;
    }

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            {area}
            {showTopFade && (
                <div
                    aria-hidden="true"
                    className={cn(
                        "pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b transition-opacity duration-150 motion-reduce:transition-none",
                        "from-card to-card/0",
                        topFadeVisible ? "opacity-100" : "opacity-0",
                    )}
                />
            )}
            {jumpToLatest !== undefined && (
                <Button
                    aria-hidden={!jumpToLatestVisible}
                    aria-label={
                        jumpToLatestWorking ? "Jump to latest message while Agent is working" : jumpToLatest.label
                    }
                    className={`group/jump pointer-events-auto absolute bottom-[calc(0.75rem+var(--composer-overlay-block,0px))] left-1/2 z-30 size-8! -translate-x-1/2 rounded-full border-[0.5px] bg-card! text-foreground shadow-[0_4px_18px_rgba(23,30,36,0.14)] transition-[opacity,scale,background-color] duration-150 ease-out hover:bg-[#f1f2f3]! active:bg-[#e6e8eb]! motion-reduce:transition-none ${jumpToLatestVisible ? "scale-100 opacity-100" : "pointer-events-none scale-90 opacity-0"}`}
                    onClick={() => {
                        const element = scrollArea.current;
                        if (element === null) {
                            return;
                        }
                        element.scrollTo({
                            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                            top: element.scrollHeight,
                        });
                        following.current = true;
                        setJumpToLatestVisible(false);
                    }}
                    size="icon"
                    tabIndex={jumpToLatestVisible ? undefined : -1}
                    variant="outline"
                >
                    {jumpToLatestWorking ? (
                        <>
                            <LoadingWave
                                className="gap-[3px] group-hover/jump:hidden"
                                dotClassName="bg-morty-text-3!"
                                size="inline"
                            />
                            <ArrowDown aria-hidden="true" className="hidden size-4 group-hover/jump:block" />
                        </>
                    ) : (
                        <ArrowDown aria-hidden="true" className="size-4" />
                    )}
                </Button>
            )}
        </div>
    );
}
