import { Download } from "lucide-react";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { textLinkClassName } from "../ui/text-link.ts";

export interface ViewerImage {
    readonly src: string;
    readonly name: string;
    readonly blob?: Blob | undefined;
}

export interface ImageDownloadModel {
    readonly state: { readonly kind: "idle" | "saving" } | { readonly kind: "failed"; readonly message: string };
    readonly onAttach: (node: HTMLElement | null) => (() => void) | undefined;
    readonly save: (image: ViewerImage) => void;
}

type DownloadFactory = () => StoreApi<ImageDownloadModel>;
const DownloadContext = createContext<DownloadFactory | null>(null);

export function ImageDownloadProvider({
    createStore,
    children,
}: {
    readonly createStore: DownloadFactory;
    readonly children: ReactNode;
}) {
    return <DownloadContext value={createStore}>{children}</DownloadContext>;
}

export const imageControlClass =
    "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full px-3 text-[13px] text-copy-secondary transition-colors hover:bg-morty-fill-opacity-2 hover:text-foreground active:bg-morty-fill-opacity-3 aria-pressed:bg-morty-fill-opacity-2 aria-pressed:text-foreground keyboard-focus:focus-visible:outline-2 keyboard-focus:focus-visible:outline-ring disabled:opacity-40 aria-disabled:opacity-40 motion-reduce:transition-none";

export function ImageDownload({ image }: { readonly image: ViewerImage }) {
    const factory = useContext(DownloadContext);
    return factory === null ? null : <DownloadControl factory={factory} image={image} />;
}

function DownloadControl({ factory, image }: { readonly factory: DownloadFactory; readonly image: ViewerImage }) {
    const store = useMemo(factory, [factory]);
    const model = useStore(store);
    return (
        <span className="contents" ref={model.onAttach}>
            <button
                aria-label="Download image"
                className={imageControlClass}
                disabled={model.state.kind === "saving"}
                onClick={() => model.save(image)}
                type="button"
            >
                <Download aria-hidden="true" className="size-4" />
                <span className="sr-only">Download image</span>
            </button>
            {model.state.kind === "failed" && (
                <span className="max-w-64 text-xs" role="alert">
                    {model.state.message}{" "}
                    <a className={textLinkClassName} href={image.src} rel="noreferrer" target="_blank">
                        Open original
                    </a>
                </span>
            )}
        </span>
    );
}
