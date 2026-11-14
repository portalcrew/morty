import { createStore } from "zustand/vanilla";
import { isDisplayableImageType, isRasterImageType } from "../../components/agents/displayable-image-type.ts";
import type {
    SessionResourceReader,
    SessionResourceRequest,
    SessionResourceStore,
} from "../../components/agents/resource-reader.ts";
import { createFilePreviewImage } from "../../services/chat/file-preview-surface.ts";

export type {
    SessionResourceReader,
    SessionResourceRequest,
    SessionResourceStore,
} from "../../components/agents/resource-reader.ts";

/**
 * Owns a session-scoped resource load — reading through the injected reader,
 * bounding it with a timeout, mapping failures, and managing the preview
 * object URL's lifetime — following the ref-cleanup protocol so components
 * only subscribe and render.
 */
export function createSessionResourceStore(request: SessionResourceRequest, read: SessionResourceReader | undefined) {
    let retry = () => {};
    return createStore<SessionResourceStore>()((set, get) => ({
        state: { kind: "loading" },
        retry: () => {
            if (get().state.kind === "failed") {
                retry();
            }
        },
        onAttach: (node) => {
            if (node === null) {
                return;
            }
            const lifetime = new AbortController();
            let media: ReturnType<typeof createFilePreviewImage> | null = null;
            const load = async (signal: AbortSignal): Promise<void> => {
                set({ state: { kind: "loading" } });
                try {
                    if (read === undefined || request.path.length === 0) {
                        set({ state: { kind: "failed" } });
                        return;
                    }
                    const file = await read(request.path, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
                    signal.throwIfAborted();
                    const mediaType = request.mediaType ?? file.mediaType;
                    if (request.kind === "text") {
                        set({ state: { kind: "text", text: new TextDecoder().decode(file.bytes) } });
                    } else if (
                        (request.kind === "image" && !isDisplayableImageType(mediaType)) ||
                        (request.kind === "raster-image" && !isRasterImageType(mediaType))
                    ) {
                        set({ state: { kind: "failed" } });
                    } else {
                        media = createFilePreviewImage(file.bytes, mediaType);
                        set({ state: { kind: "media", source: media.source, blob: media.blob } });
                    }
                } catch {
                    if (!signal.aborted) {
                        set({ state: { kind: "failed" } });
                    }
                }
            };
            retry = () => {
                void load(lifetime.signal);
            };
            void load(lifetime.signal);
            return () => {
                retry = () => {};
                lifetime.abort(new DOMException("The Session resource view detached.", "AbortError"));
                media?.dispose();
            };
        },
    }));
}
