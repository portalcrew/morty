import { isRasterImageType } from "../agents/displayable-image-type.ts";
import type { PlayableMedia } from "../agents/playable-media-type.ts";

/** Browsers save rather than render this type, whatever the bytes are. */
export const DOWNLOAD_MEDIA_TYPE = "application/octet-stream";

export interface FileSource {
    readonly source: string;
    readonly release: () => void;
}

function base64(bytes: Uint8Array): string {
    let binary = "";
    for (let start = 0; start < bytes.length; start += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    }
    return btoa(binary);
}

/**
 * A URL that shows or saves file bytes without ever running them as a Morty page. A URL on Morty's origin can be
 * opened as a document, through an "Open original" link or "Open image in new tab", and an SVG or HTML document there
 * runs script with this page's stored access. So only raster images keep their own type on Morty's origin; SVG is
 * shown through a data URL, whose document has an opaque origin; and every other type is served for download only.
 * Media recognized by its signature is the one other exception, through `createMediaSource`.
 */
export function createFileSource(bytes: Uint8Array, mediaType: string): FileSource {
    if (mediaType === "image/svg+xml") {
        return { source: `data:image/svg+xml;base64,${base64(bytes)}`, release: () => {} };
    }
    const type = isRasterImageType(mediaType) ? mediaType : DOWNLOAD_MEDIA_TYPE;
    const source = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type }));
    return { source, release: () => URL.revokeObjectURL(source) };
}

/**
 * A URL that plays media whose bytes `playableMediaType` recognized. Opened as a document, a media type renders only
 * the browser's own player, which runs no script, so the media keeps its type on Morty's origin.
 */
export function createMediaSource(
    bytes: Uint8Array<ArrayBuffer>,
    media: PlayableMedia,
): FileSource & { readonly blob: Blob } {
    const blob = new Blob([bytes], { type: media.mediaType });
    const source = URL.createObjectURL(blob);
    return { blob, source, release: () => URL.revokeObjectURL(source) };
}
