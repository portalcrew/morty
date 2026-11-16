import {
    type CSSProperties,
    type KeyboardEventHandler,
    type ReactNode,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "../ui/scroll-area.tsx";

const EDGE_THRESHOLD_PX = 4;

type ScrollEdge = "top" | "bottom";

type ScrollEdgeFadeBase = {
    readonly scrollElement?: "div" | "ul";
    readonly children: ReactNode;
    readonly frameClassName?: string;
    readonly className?: string;
    readonly viewportClassName?: string;
    /** Scrolls to the latest content once when this key changes; null resets the next selection. */
    readonly scrollToBottomKey?: string | null;
    readonly viewportLabel?: string;
    readonly id?: string;
    readonly "aria-label"?: string;
    readonly onKeyDown?: KeyboardEventHandler<HTMLElement>;
    readonly role?: React.AriaRole;
    readonly tabIndex?: number;
    readonly scrollElementRef?: (element: HTMLElement | null) => void;
};

type EdgeStrokeAppearance = {
    readonly className: string;
    /** `outside` covers a layout seam; its frame and ancestors must not clip the stroke. */
    readonly placement: "inside" | "outside";
};

type PaintedEdgeFade = ScrollEdgeFadeBase & {
    readonly fadeFromClassName: string;
    readonly fadeToClassName: string;
    readonly fadeClassName?: string;
    readonly edgeStroke?: EdgeStrokeAppearance;
    readonly revealSurface?: false;
    /**
     * Overrides the top fade placement. Session lists pass this so a sticky
     * group label stays solid while content below it fades.
     */
    readonly topFadeClassName?: string;
};

type RevealedSurfaceFade = ScrollEdgeFadeBase & {
    /**
     * Mask clipped edges so the real surface shows through. Required when that
     * surface is translucent or blurred; a painted band composites with the
     * rows and will not match the background.
     */
    readonly revealSurface: true;
    /** Optional seam stroke; omit when the scrollport sits inside a card without a border seam. */
    readonly edgeStroke?: EdgeStrokeAppearance;
};

type ScrollEdgeFadeProps = PaintedEdgeFade | RevealedSurfaceFade;

type ClippedEdges = Readonly<Record<ScrollEdge, boolean>>;

const hiddenEdges: ClippedEdges = { top: false, bottom: false };
const fadeMaskSize = "2rem";
/** Two fully transparent pixels absorb mask antialiasing at the clipped edge. */
const fadeClearSize = "2px";

function viewportEdgeMask(edges: ClippedEdges): string | undefined {
    const bottomFadeStart = `calc(100% - ${fadeMaskSize})`;
    const bottomClearStart = `calc(100% - ${fadeClearSize})`;
    if (edges.top && edges.bottom) {
        return `linear-gradient(to bottom, transparent 0, transparent ${fadeClearSize}, #000 ${fadeMaskSize}, #000 ${bottomFadeStart}, transparent ${bottomClearStart}, transparent 100%)`;
    }
    if (edges.top) {
        return `linear-gradient(to bottom, transparent 0, transparent ${fadeClearSize}, #000 ${fadeMaskSize})`;
    }
    if (edges.bottom) {
        return `linear-gradient(to bottom, #000 ${bottomFadeStart}, transparent ${bottomClearStart}, transparent 100%)`;
    }
    return undefined;
}

function surfaceMaskStyle(maskImage: string): CSSProperties {
    return {
        maskImage,
        WebkitMaskImage: maskImage,
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskSize: "100% 100%",
        WebkitMaskSize: "100% 100%",
        maskOrigin: "border-box",
        WebkitMaskOrigin: "border-box",
        maskClip: "border-box",
        WebkitMaskClip: "border-box",
        maskMode: "alpha",
    };
}

function clippedEdges(element: HTMLElement): ClippedEdges {
    return {
        top: element.scrollTop > EDGE_THRESHOLD_PX,
        bottom: element.scrollHeight - element.scrollTop - element.clientHeight > EDGE_THRESHOLD_PX,
    };
}

/**
 * Hides a gradient on each vertical edge once that edge is scrolled into view.
 * Opaque surfaces paint a band of their own color. Translucent surfaces pass
 * `revealSurface` so the mask shows the real background instead of a second color.
 */
export function ScrollEdgeFade(props: ScrollEdgeFadeProps) {
    const {
        scrollElement = "div",
        children,
        frameClassName,
        className,
        viewportClassName,
        scrollToBottomKey = null,
        id,
        "aria-label": ariaLabel,
        onKeyDown,
        role,
        tabIndex,
        scrollElementRef,
    } = props;
    const scrollRef = useRef<HTMLElement | null>(null);
    const scrolledToBottomFor = useRef<string | null>(null);
    const [edges, setEdges] = useState<ClippedEdges>(hiddenEdges);

    const syncEdges = useCallback(() => {
        const element = scrollRef.current;
        if (element === null) {
            return;
        }
        const next = clippedEdges(element);
        setEdges((current) => (current.top === next.top && current.bottom === next.bottom ? current : next));
    }, []);

    useLayoutEffect(() => {
        syncEdges();
    });

    useLayoutEffect(() => {
        if (scrollToBottomKey === null) {
            scrolledToBottomFor.current = null;
            return;
        }
        const element = scrollRef.current;
        if (element === null || scrolledToBottomFor.current === scrollToBottomKey) {
            return;
        }
        element.scrollTop = element.scrollHeight;
        scrolledToBottomFor.current = scrollToBottomKey;
        syncEdges();
    }, [scrollToBottomKey, syncEdges]);

    useEffect(() => {
        const element = scrollRef.current;
        if (element === null) {
            return;
        }
        const resizes = new ResizeObserver(syncEdges);
        resizes.observe(element);
        for (const child of element.children) {
            if (child instanceof HTMLElement) {
                resizes.observe(child);
            }
        }
        const mutations = new MutationObserver(() => {
            syncEdges();
            for (const child of element.children) {
                if (child instanceof HTMLElement) {
                    resizes.observe(child);
                }
            }
        });
        mutations.observe(element, { characterData: true, childList: true, subtree: true });
        return () => {
            mutations.disconnect();
            resizes.disconnect();
        };
    }, [syncEdges]);

    const assignScrollElement = (node: HTMLElement | null) => {
        scrollRef.current = node;
        scrollElementRef?.(node);
    };
    const revealSurface = props.revealSurface === true;
    const maskImage = revealSurface ? viewportEdgeMask(edges) : undefined;
    const list = scrollElement === "ul" ? <ul>{children}</ul> : children;

    return (
        <div className={cn("relative min-h-0", frameClassName)}>
            <ScrollArea
                aria-label={ariaLabel}
                className={cn("min-h-0", className)}
                id={id}
                onKeyDown={onKeyDown}
                onViewportScroll={() => {
                    syncEdges();
                }}
                role={role}
                tabIndex={tabIndex}
                viewportClassName={cn("h-full max-h-[inherit]", viewportClassName)}
                viewportLabel={props.viewportLabel}
                viewportRef={assignScrollElement}
                viewportStyle={maskImage === undefined ? undefined : surfaceMaskStyle(maskImage)}
            >
                {list}
            </ScrollArea>
            {props.revealSurface === true ? null : (
                <>
                    <EdgeFade
                        className={cn(
                            "inset-x-0 top-0 h-8 bg-gradient-to-b",
                            props.fadeFromClassName,
                            props.fadeToClassName,
                            props.fadeClassName,
                            props.topFadeClassName,
                        )}
                        visible={edges.top}
                    />
                    <EdgeFade
                        className={cn(
                            "inset-x-0 bottom-0 h-8 bg-gradient-to-t",
                            props.fadeFromClassName,
                            props.fadeToClassName,
                            props.fadeClassName,
                        )}
                        visible={edges.bottom}
                    />
                </>
            )}
            {props.edgeStroke !== undefined && (
                <>
                    <EdgeStroke
                        className={props.edgeStroke.className}
                        edge="top"
                        placement={props.edgeStroke.placement}
                        visible={edges.top}
                    />
                    <EdgeStroke
                        className={props.edgeStroke.className}
                        edge="bottom"
                        placement={props.edgeStroke.placement}
                        visible={edges.bottom}
                    />
                </>
            )}
        </div>
    );
}

function EdgeStroke({
    className,
    edge,
    placement,
    visible,
}: {
    readonly className: string;
    readonly edge: ScrollEdge;
    readonly placement: "inside" | "outside";
    readonly visible: boolean;
}) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                "pointer-events-none absolute inset-x-0 z-10 h-px transition-opacity duration-150 motion-reduce:transition-none",
                edge === "top"
                    ? placement === "outside"
                        ? "-top-px border-b-[1px]"
                        : "top-0 border-t-[1px]"
                    : placement === "outside"
                      ? "-bottom-px border-t-[1px]"
                      : "bottom-0 border-b-[1px]",
                className,
                visible ? "opacity-100" : "opacity-0",
            )}
        />
    );
}

function EdgeFade({ className, visible }: { readonly className: string; readonly visible: boolean }) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                "pointer-events-none absolute z-10 transition-opacity duration-150 motion-reduce:transition-none",
                className,
                visible ? "opacity-100" : "opacity-0",
            )}
        />
    );
}
