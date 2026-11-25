// Vision models downsample larger images before reading them; the extra pixels only cost transfer and Agent history.
const PROMPT_IMAGE_MAX_EDGE = 2_048;
// Eight images of this size stay under 32 MB once base64-encoded, the largest message Morty reads from Codex.
const PROMPT_IMAGE_TARGET_BYTES = 2_500_000;
const PROMPT_IMAGE_EDGES = [PROMPT_IMAGE_MAX_EDGE, 1_536, 1_024, 768];

interface ImageSize {
    readonly width: number;
    readonly height: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function pngSize(bytes: Uint8Array, view: DataView): ImageSize | null {
    if (bytes.byteLength < 24 || bytes[0] !== 0x89 || ascii(bytes, 1, 3) !== "PNG" || ascii(bytes, 12, 4) !== "IHDR") {
        return null;
    }
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

function isJpegFrameHeader(marker: number): boolean {
    return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | null {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return null;
    }
    let offset = 2;
    while (offset + 4 <= bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
            return null;
        }
        const marker = bytes[offset + 1] ?? 0;
        if (marker === 0xff) {
            offset += 1;
            continue;
        }
        if (isJpegFrameHeader(marker)) {
            return offset + 9 <= bytes.byteLength
                ? { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
                : null;
        }
        offset += 2 + view.getUint16(offset + 2);
    }
    return null;
}

function webpSize(bytes: Uint8Array, view: DataView): ImageSize | null {
    if (bytes.byteLength < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
        return null;
    }
    switch (ascii(bytes, 12, 4)) {
        case "VP8 ":
            return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
        case "VP8L": {
            const bits = view.getUint32(21, true);
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        case "VP8X": {
            const animated = ((bytes[20] ?? 0) & 0x02) !== 0;
            if (animated) {
                return null;
            }
            const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
            const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
            return { width, height };
        }
        default:
            return null;
    }
}

function encodedSize(bytes: Uint8Array, mediaType: string): ImageSize | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (mediaType) {
        case "image/png":
            return pngSize(bytes, view);
        case "image/jpeg":
            return jpegSize(bytes, view);
        case "image/webp":
            return webpSize(bytes, view);
        default:
            // A canvas keeps only the first frame of an animated GIF, so GIFs are never resized.
            return null;
    }
}

export function promptImageEdges(bytes: Uint8Array, mediaType: string): readonly number[] {
    const size = encodedSize(bytes, mediaType);
    if (size === null) {
        return [];
    }
    const longEdge = Math.max(size.width, size.height);
    if (longEdge <= PROMPT_IMAGE_MAX_EDGE && bytes.byteLength <= PROMPT_IMAGE_TARGET_BYTES) {
        return [];
    }
    return PROMPT_IMAGE_EDGES.filter((edge) => edge < longEdge);
}

export function fitsPromptImageTarget(byteLength: number): boolean {
    return byteLength <= PROMPT_IMAGE_TARGET_BYTES;
}

export function promptImageSize(decoded: ImageSize, edge: number): ImageSize {
    const scale = Math.min(1, edge / Math.max(decoded.width, decoded.height));
    return {
        width: Math.max(1, Math.round(decoded.width * scale)),
        height: Math.max(1, Math.round(decoded.height * scale)),
    };
}
