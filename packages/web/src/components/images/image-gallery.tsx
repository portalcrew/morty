import { ChevronLeft, ChevronRight, X } from "lucide-react";
import {
    type ComponentProps,
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils.ts";
import { ImageCanvas } from "./image-canvas.tsx";
import { imageControlClass, type ViewerImage } from "./image-download.tsx";

interface Gallery {
    readonly register: (node: HTMLButtonElement, image: ViewerImage) => () => void;
    readonly open: (node: HTMLButtonElement) => void;
}
interface OpenGallery {
    readonly images: readonly ViewerImage[];
    readonly index: number;
    readonly restoreFocus: () => void;
}
const GalleryContext = createContext<Gallery | null>(null);
const ViewerContext = createContext<((gallery: OpenGallery) => void) | null>(null);

/** The modal outlives thumbnails that disappear when a finished turn collapses its tools. */
export function ImageViewerProvider({ children }: { readonly children: ReactNode }) {
    const [opened, setOpened] = useState<OpenGallery | null>(null);
    const close = useCallback(() => setOpened(null), []);
    return (
        <ViewerContext value={setOpened}>
            {children}
            {opened !== null && createPortal(<ImageViewer gallery={opened} onClose={close} />, document.body)}
        </ViewerContext>
    );
}

/** Each message or attachment group owns a gallery; nested Markdown shares it. */
export function ImageGallery({ children }: { readonly children: ReactNode }) {
    const parent = useContext(GalleryContext);
    const open = useContext(ViewerContext);
    if (parent !== null) {
        return children;
    }
    return open === null ? (
        <ImageViewerProvider>
            <ImageGallery>{children}</ImageGallery>
        </ImageViewerProvider>
    ) : (
        <GalleryScope open={open}>{children}</GalleryScope>
    );
}

function GalleryScope({
    children,
    open,
}: {
    readonly children: ReactNode;
    readonly open: (gallery: OpenGallery) => void;
}) {
    const entries = useRef(new Map<HTMLButtonElement, ViewerImage>());
    const pendingFocus = useRef<{ readonly name: string; readonly from: Element | null } | null>(null);
    const gallery = useMemo<Gallery>(
        () => ({
            register: (node, image) => {
                entries.current.set(node, image);
                if (pendingFocus.current?.name === image.name) {
                    // Streaming Markdown can replace a thumbnail with a loading placeholder.
                    // Return focus when its image arrives, unless the user has moved elsewhere.
                    if (
                        document.activeElement === document.body ||
                        document.activeElement === pendingFocus.current.from
                    ) {
                        node.focus({ preventScroll: true });
                    }
                    pendingFocus.current = null;
                }
                return () => {
                    entries.current.delete(node);
                };
            },
            open: (origin) => {
                pendingFocus.current = null;
                const ordered = [...entries.current.entries()]
                    .filter(([node]) => node.isConnected)
                    .sort(([left], [right]) =>
                        left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
                    );
                const index = ordered.findIndex(([node]) => node === origin);
                if (index < 0) {
                    return;
                }
                const ancestors: HTMLElement[] = [];
                for (let parent = origin.parentElement; parent !== null; parent = parent.parentElement) {
                    ancestors.push(parent);
                }
                const images = ordered.map(([, image]) => image);
                open({
                    images,
                    index,
                    restoreFocus: () => {
                        const original = ordered[index]?.[1];
                        const thumbnail = origin.isConnected
                            ? origin
                            : [...entries.current.entries()].find(([, image]) => image.name === original?.name)?.[0];
                        const target =
                            thumbnail ??
                            ancestors
                                .find((node) => node.isConnected)
                                ?.querySelector<HTMLElement>("button, [tabindex]");
                        target?.focus({ preventScroll: true });
                        if (target == null && original !== undefined) {
                            pendingFocus.current = { name: original.name, from: document.activeElement };
                        }
                    },
                });
            },
        }),
        [open],
    );
    return <GalleryContext value={gallery}>{children}</GalleryContext>;
}

export function PreviewImage(
    props: ComponentProps<"img"> & { readonly blob?: Blob | undefined; readonly insetStroke?: boolean },
) {
    const gallery = useContext(GalleryContext);
    return gallery === null ? (
        <ImageGallery>
            <PreviewImage {...props} />
        </ImageGallery>
    ) : (
        <ImageTrigger {...props} gallery={gallery} />
    );
}

export function UserImagePlaceholder() {
    return (
        <span
            aria-label="Loading image"
            className="block size-[120px] max-w-full shrink-0 rounded-[12px] bg-morty-fill-opacity-2"
            role="status"
        />
    );
}

function ImageTrigger({
    gallery,
    blob,
    alt,
    src,
    className,
    insetStroke = false,
    onLoad,
    ...props
}: ComponentProps<"img"> & {
    readonly blob?: Blob | undefined;
    readonly gallery: Gallery;
    readonly insetStroke?: boolean;
}) {
    const name = alt?.trim() || "Image";
    const [loadedSource, setLoadedSource] = useState<string | null>(null);
    const loading = insetStroke && typeof src === "string" && loadedSource !== src;
    const register = useCallback(
        (node: HTMLButtonElement | null) => {
            return node === null || typeof src !== "string" ? undefined : gallery.register(node, { src, name, blob });
        },
        [gallery, src, name, blob],
    );
    return (
        <button
            aria-label={`View image: ${name}`}
            className={cn(
                "relative inline-flex max-w-full cursor-zoom-in items-center justify-center rounded-lg align-middle outline-none keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring",
                insetStroke && "rounded-[12px]",
                loading && "bg-morty-fill-opacity-2",
            )}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                gallery.open(event.currentTarget);
            }}
            ref={register}
            type="button"
        >
            <img
                {...props}
                alt={alt ?? ""}
                className={cn("max-h-[480px] max-w-full object-contain", className)}
                onLoad={(event) => {
                    setLoadedSource(src ?? null);
                    onLoad?.(event);
                }}
                src={src}
            />
            {insetStroke && (
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-[inherit]"
                    style={{ boxShadow: "inset 0 0 0 0.5px color-mix(in srgb, var(--foreground) 8%, transparent)" }}
                />
            )}
        </button>
    );
}

function isViewerEntry(id: string): boolean {
    const state: unknown = window.history.state;
    return typeof state === "object" && state !== null && "mortyImageViewer" in state && state.mortyImageViewer === id;
}

function ImageViewer({ gallery, onClose }: { readonly gallery: OpenGallery; readonly onClose: () => void }) {
    const [index, setIndex] = useState(gallery.index);
    const dismiss = useRef(onClose);
    const attached = useRef<HTMLDialogElement | null>(null);
    const entryId = useRef<string | null>(null);
    const onAttach = useCallback(
        (dialog: HTMLDialogElement | null) => {
            if (dialog === null) {
                return;
            }
            attached.current = dialog;
            const id = entryId.current ?? crypto.randomUUID();
            if (entryId.current === null) {
                entryId.current = id;
                const state: unknown = window.history.state;
                window.history.pushState(
                    { ...(typeof state === "object" && state !== null ? state : {}), mortyImageViewer: id },
                    "",
                );
            }
            let leaving = false;
            const close = () => {
                if (leaving) {
                    return;
                }
                if (isViewerEntry(id)) {
                    leaving = true;
                    window.history.back();
                } else {
                    onClose();
                }
            };
            dismiss.current = close;
            const onPop = () => {
                if (!isViewerEntry(id)) {
                    leaving = true;
                    onClose();
                }
            };
            window.addEventListener("popstate", onPop);
            if (!dialog.open) {
                dialog.showModal();
            }
            dialog.querySelector<HTMLButtonElement>("[data-image-close]")?.focus({ preventScroll: true });
            return () => {
                window.removeEventListener("popstate", onPop);
                attached.current = null;
                // StrictMode replays callback refs; defer teardown until a real detach.
                queueMicrotask(() => {
                    if (attached.current !== null) {
                        return;
                    }
                    if (!leaving && isViewerEntry(id)) {
                        window.history.back();
                    }
                    dialog.close();
                    gallery.restoreFocus();
                });
            };
        },
        [gallery, onClose],
    );
    const image = gallery.images[index];
    if (image === undefined) {
        return null;
    }
    return (
        <dialog
            aria-label="Image viewer"
            className="fixed inset-0 z-50 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-transparent p-0 text-foreground outline-none backdrop:bg-black/70"
            onCancel={(event) => {
                event.preventDefault();
                dismiss.current();
            }}
            onClick={(event) => {
                if (
                    event.target === event.currentTarget ||
                    (event.target instanceof HTMLElement && event.target.dataset["imageOverlay"] === "")
                ) {
                    dismiss.current();
                }
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    dismiss.current();
                }
                if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    setIndex((current) => Math.max(0, current - 1));
                }
                if (event.key === "ArrowRight") {
                    event.preventDefault();
                    setIndex((current) => Math.min(gallery.images.length - 1, current + 1));
                }
            }}
            ref={onAttach}
        >
            <div className="relative flex h-full flex-col" data-image-overlay="">
                {gallery.images.length > 1 && (
                    <div className="absolute left-4 top-[max(16px,env(safe-area-inset-top))] z-10 flex items-center gap-1 rounded-full border border-white/80 bg-card/95 px-1 py-1 shadow-lg sm:left-8">
                        <button
                            aria-label="Previous image"
                            className={imageControlClass}
                            aria-disabled={index === 0}
                            onClick={() => setIndex(Math.max(0, index - 1))}
                            type="button"
                        >
                            <ChevronLeft aria-hidden="true" className="size-5" />
                        </button>
                        <span
                            aria-live="polite"
                            className="min-w-12 text-center text-xs tabular-nums text-copy-secondary"
                        >
                            {index + 1} of {gallery.images.length}
                        </span>
                        <button
                            aria-label="Next image"
                            className={imageControlClass}
                            aria-disabled={index === gallery.images.length - 1}
                            onClick={() => setIndex(Math.min(gallery.images.length - 1, index + 1))}
                            type="button"
                        >
                            <ChevronRight aria-hidden="true" className="size-5" />
                        </button>
                    </div>
                )}
                <button
                    aria-label="Close image viewer"
                    className="absolute right-4 top-[max(16px,env(safe-area-inset-top))] z-10 flex size-11 items-center justify-center rounded-full border border-white/80 bg-card/95 text-copy-secondary shadow-lg transition-colors hover:bg-card hover:text-foreground keyboard-focus:focus-visible:outline-2 keyboard-focus:focus-visible:outline-ring sm:right-8"
                    data-image-close=""
                    onClick={() => dismiss.current()}
                    type="button"
                >
                    <X aria-hidden="true" className="size-5" />
                </button>
                <ImageCanvas
                    image={image}
                    key={index}
                    mode="overlay"
                    onBackdrop={() => dismiss.current()}
                    onStep={(direction) =>
                        setIndex((current) => Math.max(0, Math.min(gallery.images.length - 1, current + direction)))
                    }
                />
            </div>
        </dialog>
    );
}
