import { Maximize, Minus, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils.ts";
import { isRasterImageType } from "../agents/displayable-image-type.ts";
import { ImageDownload, imageControlClass, type ViewerImage } from "./image-download.tsx";

type Dimensions = { readonly width: number; readonly height: number };
type Viewport = Dimensions & { readonly fitTop: number; readonly fitBottom: number };
type DecodedImage = { readonly kind: "loading" | "failed" } | { readonly kind: "ready"; readonly size: Dimensions };
type Zoom = { readonly kind: "fit" } | { readonly kind: "scale"; readonly value: number };

function clampPan(value: number, imageSize: number, viewportSize: number): number {
    const limit = Math.max(0, (imageSize - viewportSize) / 2);
    return Math.max(-limit, Math.min(limit, value));
}

/** Shared by the conversation lightbox and the existing file preview panel. */
export function ImageCanvas({
    image,
    onStep,
    onBackdrop,
    testId,
    mode = "panel",
}: {
    readonly image: ViewerImage;
    readonly onStep?: ((direction: -1 | 1) => void) | undefined;
    readonly onBackdrop?: (() => void) | undefined;
    readonly testId?: string;
    readonly mode?: "overlay" | "panel";
}) {
    const [decoded, setDecoded] = useState<DecodedImage>({ kind: "loading" });
    const [viewport, setViewport] = useState<Viewport>({ width: 1, height: 1, fitTop: 0, fitBottom: 0 });
    const [zoom, setZoom] = useState<Zoom>({ kind: "fit" });
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [attempt, setAttempt] = useState(0);
    const [source, setSource] = useState(image.src);
    const surface = useRef<HTMLElement | null>(null);
    const pointers = useRef(new Map<number, { readonly x: number; readonly y: number }>());
    const gesture = useRef({ moved: false, background: false, multiple: false, x: 0, y: 0 });
    const natural = decoded.kind === "ready" ? decoded.size : viewport;
    const fit = Math.min(
        1,
        Math.max(1, viewport.width - (mode === "overlay" ? 64 : 0)) / natural.width,
        Math.max(1, viewport.height - viewport.fitTop - viewport.fitBottom) / natural.height,
    );
    const scale = zoom.kind === "fit" ? fit : zoom.value;
    const canPan = natural.width * scale > viewport.width || natural.height * scale > viewport.height;
    const fitOffsetY = (viewport.fitTop - viewport.fitBottom) / 2;
    const wheelView = useRef({ scale, x: pan.x, y: zoom.kind === "fit" ? fitOffsetY : pan.y });
    const onWheel = useRef<(event: WheelEvent) => void>(() => {});
    useEffect(() => {
        wheelView.current = { scale, x: pan.x, y: zoom.kind === "fit" ? fitOffsetY : pan.y };
        onWheel.current = (event) => {
            if (mode !== "overlay" || decoded.kind !== "ready") {
                return;
            }
            event.preventDefault();
            if (event.deltaY === 0) {
                return;
            }
            if (!(event.currentTarget instanceof HTMLElement)) {
                return;
            }
            const bounds = event.currentTarget.getBoundingClientRect();
            const cursorX = event.clientX - bounds.left - bounds.width / 2;
            const cursorY = event.clientY - bounds.top - bounds.height / 2;
            const current = wheelView.current;
            const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1);
            const nextScale = Math.max(0.05, Math.min(8, current.scale * Math.exp(-delta * 0.0015)));
            const ratio = nextScale / current.scale;
            const next = {
                scale: nextScale,
                x: clampPan(cursorX - (cursorX - current.x) * ratio, natural.width * nextScale, viewport.width),
                y: clampPan(cursorY - (cursorY - current.y) * ratio, natural.height * nextScale, viewport.height),
            };
            wheelView.current = next;
            setPan({ x: next.x, y: next.y });
            setZoom({ kind: "scale", value: nextScale });
        };
    }, [
        decoded.kind,
        fitOffsetY,
        mode,
        natural.height,
        natural.width,
        pan.x,
        pan.y,
        scale,
        viewport.height,
        viewport.width,
        zoom.kind,
    ]);
    const changeScale = (value: number) => {
        const next = Math.max(0.05, Math.min(8, value));
        if (mode === "overlay") {
            setPan((current) => ({
                x: clampPan((current.x * next) / scale, natural.width * next, viewport.width),
                y: clampPan((current.y * next) / scale, natural.height * next, viewport.height),
            }));
            setZoom({ kind: "scale", value: next });
            return;
        }
        const node = surface.current;
        const left =
            node === null
                ? 0
                : (node.scrollLeft + viewport.width / 2 - Math.max(0, (viewport.width - natural.width * scale) / 2)) /
                  scale;
        const top =
            node === null
                ? 0
                : (node.scrollTop + viewport.height / 2 - Math.max(0, (viewport.height - natural.height * scale) / 2)) /
                  scale;
        setZoom({ kind: "scale", value: next });
        // The ref callback below recenters after React commits the new dimensions.
        center.current = { left: left * next - viewport.width / 2, top: top * next - viewport.height / 2 };
    };
    const center = useRef<{ readonly left: number; readonly top: number } | null>(null);
    const onAttach = useCallback(
        (node: HTMLElement | null) => {
            surface.current = node;
            if (node === null) {
                return;
            }
            // Own a URL for the immutable bytes: the thumbnail may unmount or its file may change. Only a raster image
            // gets one on Morty's origin; any other source is the self-contained URL createFileSource gave it.
            const ownedSource =
                image.blob === undefined || !isRasterImageType(image.blob.type)
                    ? null
                    : URL.createObjectURL(image.blob);
            setSource(ownedSource ?? image.src);
            const toolbar = node.previousElementSibling;
            const close = node.closest("dialog")?.querySelector("[data-image-close]") ?? null;
            const handleWheel = (event: WheelEvent) => onWheel.current(event);
            if (mode === "overlay") {
                node.addEventListener("wheel", handleWheel, { passive: false });
            }
            const resize = () => {
                const bounds = node.getBoundingClientRect();
                setViewport({
                    width: Math.max(1, node.clientWidth),
                    height: Math.max(1, node.clientHeight),
                    fitTop:
                        mode === "overlay" && close !== null
                            ? Math.max(0, close.getBoundingClientRect().bottom - bounds.top) + 12
                            : 0,
                    fitBottom:
                        mode === "overlay" && toolbar !== null
                            ? Math.max(0, bounds.bottom - toolbar.getBoundingClientRect().top) + 12
                            : 0,
                });
            };
            resize();
            const observer = new ResizeObserver(resize);
            observer.observe(node);
            if (mode === "overlay" && toolbar !== null) {
                observer.observe(toolbar);
            }
            if (mode === "overlay" && close !== null) {
                observer.observe(close);
            }
            return () => {
                observer.disconnect();
                node.removeEventListener("wheel", handleWheel);
                if (ownedSource !== null) {
                    URL.revokeObjectURL(ownedSource);
                }
                surface.current = null;
            };
        },
        [image.blob, image.src, mode],
    );
    return (
        <div className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
            <div
                aria-label="Image controls"
                className={cn(
                    "flex shrink-0 items-center justify-center gap-1",
                    mode === "overlay"
                        ? "fixed bottom-[max(16px,env(safe-area-inset-bottom))] left-1/2 z-10 max-w-[calc(100vw-24px)] -translate-x-1/2 overflow-x-auto rounded-full bg-card px-1 py-1 outline-1 outline-solid outline-foreground/8 shadow-[0_4px_12px_rgba(23,30,36,0.14),0_16px_36px_rgba(23,30,36,0.22)]"
                        : "flex-wrap border-b border-border/60 bg-card px-3 py-2",
                )}
                role="toolbar"
            >
                <button
                    aria-label="Zoom out"
                    className={imageControlClass}
                    disabled={decoded.kind !== "ready" || scale <= 0.05}
                    onClick={() => changeScale(scale / 1.5)}
                    type="button"
                >
                    <Minus aria-hidden="true" className="size-4" />
                </button>
                <output aria-label="Zoom level" className="min-w-12 text-center text-xs tabular-nums">
                    {decoded.kind === "ready" ? `${Math.round(scale * 100)}%` : "—"}
                </output>
                <button
                    aria-label="Zoom in"
                    className={imageControlClass}
                    disabled={decoded.kind !== "ready" || scale >= 8}
                    onClick={() => changeScale(scale * 1.5)}
                    type="button"
                >
                    <Plus aria-hidden="true" className="size-4" />
                </button>
                <button
                    aria-label="Fit image"
                    aria-pressed={zoom.kind === "fit"}
                    className={imageControlClass}
                    onClick={() => {
                        setPan({ x: 0, y: 0 });
                        setZoom({ kind: "fit" });
                    }}
                    type="button"
                >
                    <Maximize aria-hidden="true" className="size-4" />
                    <span className="hidden sm:inline">Fit</span>
                </button>
                <button
                    aria-label="Actual size"
                    aria-pressed={zoom.kind === "scale" && zoom.value === 1}
                    className={imageControlClass}
                    onClick={() => changeScale(1)}
                    type="button"
                >
                    100%
                </button>
                <ImageDownload image={{ ...image, src: source }} />
            </div>
            <section
                aria-label="Image canvas"
                className={cn(
                    "relative min-h-0 flex-1 touch-none overscroll-contain outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-inset keyboard-focus:focus-visible:ring-ring",
                    mode === "overlay" ? "overflow-hidden" : "overflow-auto",
                    mode === "overlay" && canPan && "cursor-grab active:cursor-grabbing",
                    mode === "panel" && "bg-surface-subtle",
                )}
                onDoubleClick={() => {
                    if (zoom.kind === "fit") {
                        changeScale(1);
                    } else {
                        setPan({ x: 0, y: 0 });
                        setZoom({ kind: "fit" });
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === "+" || event.key === "=") {
                        event.preventDefault();
                        changeScale(scale * 1.5);
                    }
                    if (event.key === "-") {
                        event.preventDefault();
                        changeScale(scale / 1.5);
                    }
                    if (event.key === "0") {
                        event.preventDefault();
                        setPan({ x: 0, y: 0 });
                        setZoom({ kind: "fit" });
                    }
                }}
                onPointerDown={(event) => {
                    if (
                        event.button !== 0 ||
                        (event.target instanceof Element && event.target.closest("button, a") !== null)
                    ) {
                        return;
                    }
                    if (pointers.current.size === 0) {
                        gesture.current = {
                            moved: false,
                            background:
                                event.target === event.currentTarget ||
                                (event.target instanceof HTMLElement && event.target.dataset["imageBackground"] === ""),
                            multiple: false,
                            x: event.clientX,
                            y: event.clientY,
                        };
                    } else {
                        gesture.current.multiple = true;
                    }
                    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                    event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                    const previous = pointers.current.get(event.pointerId);
                    if (previous === undefined) {
                        return;
                    }
                    const next = { x: event.clientX, y: event.clientY };
                    const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
                    if (Math.abs(next.x - gesture.current.x) + Math.abs(next.y - gesture.current.y) > 4) {
                        gesture.current.moved = true;
                    }
                    if (other !== undefined) {
                        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
                        if (before > 0) {
                            changeScale((scale * Math.hypot(next.x - other.x, next.y - other.y)) / before);
                        }
                        gesture.current.moved = true;
                    } else if (mode === "overlay") {
                        setPan((current) => ({
                            x: clampPan(current.x + next.x - previous.x, natural.width * scale, viewport.width),
                            y: clampPan(current.y + next.y - previous.y, natural.height * scale, viewport.height),
                        }));
                    } else {
                        event.currentTarget.scrollLeft += previous.x - next.x;
                        event.currentTarget.scrollTop += previous.y - next.y;
                    }
                    pointers.current.set(event.pointerId, next);
                }}
                onPointerUp={(event) => {
                    pointers.current.delete(event.pointerId);
                    const dx = event.clientX - gesture.current.x;
                    const dy = event.clientY - gesture.current.y;
                    if (
                        event.pointerType === "touch" &&
                        zoom.kind === "fit" &&
                        !gesture.current.multiple &&
                        Math.abs(dx) > 60 &&
                        Math.abs(dx) > Math.abs(dy)
                    ) {
                        onStep?.(dx < 0 ? 1 : -1);
                    }
                    if (!gesture.current.moved && gesture.current.background && pointers.current.size === 0) {
                        onBackdrop?.();
                    }
                }}
                onPointerCancel={(event) => {
                    pointers.current.delete(event.pointerId);
                    gesture.current.moved = true;
                }}
                ref={onAttach}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the image canvas supports keyboard zoom and panel scrolling.
                tabIndex={0}
            >
                <div
                    className={cn(
                        "flex items-center justify-center",
                        mode === "overlay" ? "h-full w-full" : "min-h-full min-w-full",
                    )}
                    data-image-background=""
                    style={
                        mode === "overlay"
                            ? undefined
                            : { width: natural.width * scale, height: natural.height * scale }
                    }
                    ref={(node) => {
                        if (node !== null && center.current !== null && surface.current !== null) {
                            surface.current.scrollLeft = center.current.left;
                            surface.current.scrollTop = center.current.top;
                            center.current = null;
                        }
                    }}
                >
                    {decoded.kind === "loading" && (
                        <span className="absolute text-sm text-muted-foreground" role="status">
                            Loading image…
                        </span>
                    )}
                    {decoded.kind === "failed" ? (
                        <div className="grid justify-items-center gap-3 p-6" role="alert">
                            <p>Couldn't display this image.</p>
                            <button
                                className={imageControlClass}
                                onClick={() => {
                                    setDecoded({ kind: "loading" });
                                    setAttempt(attempt + 1);
                                }}
                                type="button"
                            >
                                <RotateCw aria-hidden="true" className="size-4" />
                                Retry image
                            </button>
                        </div>
                    ) : (
                        <img
                            alt={image.name}
                            className="block shrink-0 select-none object-contain"
                            data-testid={testId}
                            draggable={false}
                            key={attempt}
                            onError={() => setDecoded({ kind: "failed" })}
                            onLoad={(event) =>
                                setDecoded({
                                    kind: "ready",
                                    size: {
                                        width: event.currentTarget.naturalWidth,
                                        height: event.currentTarget.naturalHeight,
                                    },
                                })
                            }
                            src={source}
                            style={{
                                width: decoded.kind === "ready" ? natural.width * scale : undefined,
                                height: decoded.kind === "ready" ? natural.height * scale : undefined,
                                maxWidth: "none",
                                transform:
                                    mode === "overlay"
                                        ? `translate3d(${pan.x}px, ${zoom.kind === "fit" ? (viewport.fitTop - viewport.fitBottom) / 2 : pan.y}px, 0)`
                                        : undefined,
                            }}
                        />
                    )}
                </div>
            </section>
        </div>
    );
}
