import { readLocalRaster } from "../../content/raster.ts";

const IMAGE_MARKER = /\[@image\]\(([^)\r\n]*)(?:\)|$)/g;
const DATA_IMAGE_HEADER = /^data:(image\/[a-z+]+);base64,/;
const BASE_64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SESSION_HISTORY_IMAGE_CHARACTER_LIMIT = 4_000_000;

interface NativeHistoryImage {
    readonly data: string;
    readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

function isRasterMime(value: string): value is NativeHistoryImage["mimeType"] {
    return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp";
}

/** Decode inline raster images before attempting the authorized local-file path. */
function parseNativeHistoryImage(uri: string): NativeHistoryImage | null {
    const header = DATA_IMAGE_HEADER.exec(uri);
    if (header === null) {
        return null;
    }
    const mimeType = header[1] ?? "";
    const data = uri.slice(header[0].length);
    if (!isRasterMime(mimeType) || data.length < 4 || data.length > SESSION_HISTORY_IMAGE_CHARACTER_LIMIT) {
        return null;
    }
    if (data.length % 4 !== 0 || !BASE_64.test(data)) {
        return null;
    }
    return { data, mimeType };
}

export async function resolveHistoryTextImages(
    value: string,
    signal: AbortSignal,
): Promise<{ readonly text: string; readonly images: readonly NativeHistoryImage[] }> {
    signal.throwIfAborted();
    const images: NativeHistoryImage[] = [];
    let imageCharacters = 0;
    const text = await replaceImageMarkers(value, async (uri) => {
        if (images.length >= 8 || imageCharacters >= SESSION_HISTORY_IMAGE_CHARACTER_LIMIT) {
            return "[Image unavailable]";
        }
        const embedded = parseNativeHistoryImage(uri);
        if (embedded !== null) {
            if (imageCharacters + embedded.data.length > SESSION_HISTORY_IMAGE_CHARACTER_LIMIT) {
                return "[Image unavailable]";
            }
            images.push(embedded);
            imageCharacters += embedded.data.length;
            return "";
        }
        const local = await readLocalRaster(uri, signal);
        if (local === null) {
            return "[Image unavailable]";
        }
        const data = await local.base64();
        if (imageCharacters + data.length > SESSION_HISTORY_IMAGE_CHARACTER_LIMIT) {
            return "[Image unavailable]";
        }
        images.push({
            data,
            mimeType: local.mimeType,
        });
        imageCharacters += data.length;
        return "";
    });
    return { text, images };
}

async function replaceImageMarkers(text: string, replace: (uri: string) => Promise<string>): Promise<string> {
    const matches = [...text.matchAll(IMAGE_MARKER)];
    if (matches.length === 0) {
        return text;
    }
    let cursor = 0;
    let rewritten = "";
    for (const match of matches) {
        const index = match.index;
        rewritten += text.slice(cursor, index);
        rewritten += await replace(match[1] ?? "");
        cursor = index + match[0].length;
    }
    return `${rewritten}${text.slice(cursor)}`;
}
