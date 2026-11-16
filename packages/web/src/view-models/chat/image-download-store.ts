import { createStore } from "zustand/vanilla";
import type { ImageDownloadModel, ViewerImage } from "../../components/images/image-download.tsx";
import { downloadLocalFile } from "../../services/chat/local-file-download.ts";

export function createImageDownloadStore() {
    let lifetime: AbortController | null = null;
    return createStore<ImageDownloadModel>()((set, get) => {
        const save = async (image: ViewerImage, signal: AbortSignal): Promise<void> => {
            set({ state: { kind: "saving" } });
            try {
                const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
                let blob = image.blob;
                if (blob === undefined) {
                    const response = await fetch(image.src, { signal: bounded, credentials: "omit" });
                    if (!response.ok) {
                        throw new Error("Image download failed");
                    }
                    blob = await response.blob();
                }
                bounded.throwIfAborted();
                const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") ?? "png";
                downloadLocalFile({
                    blob,
                    name: /\.[a-z0-9]+$/iu.test(image.name) ? image.name : `${image.name}.${extension}`,
                });
                set({ state: { kind: "idle" } });
            } catch {
                if (!signal.aborted) {
                    set({
                        state: {
                            kind: "failed",
                            message: "Couldn't download this image. Try again or open the original to save it.",
                        },
                    });
                }
            }
        };
        return {
            state: { kind: "idle" },
            onAttach: (node) => {
                if (node === null) {
                    return;
                }
                const controller = new AbortController();
                lifetime = controller;
                return () => {
                    controller.abort();
                    if (lifetime === controller) {
                        lifetime = null;
                    }
                };
            },
            save: (image) => {
                if (lifetime !== null && get().state.kind !== "saving") {
                    void save(image, lifetime.signal);
                }
            },
        };
    });
}
