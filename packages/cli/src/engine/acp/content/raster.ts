import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath, readFileBytes, readFileStart, readPathMetadata } from "../../storage/files/local-files.ts";

const MAX_LOCAL_RASTER_BYTES = 128 * 1024 * 1024;
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
const JPEG_SIGNATURE = Uint8Array.of(0xff, 0xd8, 0xff);
const GIF87_SIGNATURE = new TextEncoder().encode("GIF87a");
const GIF89_SIGNATURE = new TextEncoder().encode("GIF89a");
const RIFF_SIGNATURE = new TextEncoder().encode("RIFF");
const WEBP_SIGNATURE = new TextEncoder().encode("WEBP");

export type LocalRasterMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** A local image file identified by canonical path, read on demand. */
export class LocalRasterImage {
    readonly mimeType: LocalRasterMimeType;
    readonly sourceUri: string;

    constructor(mimeType: LocalRasterMimeType, sourceUri: string) {
        this.mimeType = mimeType;
        this.sourceUri = sourceUri;
    }

    readonly base64 = async (): Promise<string> => Buffer.from(await readFileBytes(this.sourceUri)).toString("base64");
}

function startsWith(bytes: Uint8Array, signature: Uint8Array, offset = 0): boolean {
    if (bytes.byteLength < offset + signature.byteLength) {
        return false;
    }
    return signature.every((value, index) => bytes[offset + index] === value);
}

export function sniffRasterMime(bytes: Uint8Array): LocalRasterMimeType | null {
    if (startsWith(bytes, PNG_SIGNATURE)) {
        return "image/png";
    }
    if (startsWith(bytes, JPEG_SIGNATURE)) {
        return "image/jpeg";
    }
    if (startsWith(bytes, GIF87_SIGNATURE) || startsWith(bytes, GIF89_SIGNATURE)) {
        return "image/gif";
    }
    if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) {
        return "image/webp";
    }
    return null;
}

async function resolveCanonicalPath(requested: string, signal: AbortSignal): Promise<string | null> {
    signal.throwIfAborted();
    if (!isAbsolute(requested) || requested.includes("\0") || normalize(requested) !== requested) {
        return null;
    }
    try {
        const target = await canonicalPath(requested);
        signal.throwIfAborted();
        if (!isAbsolute(target) || normalize(target) !== target) {
            return null;
        }
        return target;
    } catch (cause) {
        signal.throwIfAborted();
        if (cause instanceof Error && cause.name === "AbortError") {
            throw cause;
        }
        return null;
    }
}

function parseLocalImageUri(uri: string): string | null {
    const trimmed = uri.trim();
    if (trimmed.length === 0 || trimmed.length > 2_048 || trimmed.includes("\0")) {
        return null;
    }
    if (trimmed.startsWith("data:")) {
        return null;
    }
    if (trimmed.startsWith("file:")) {
        try {
            const url = new URL(trimmed);
            if (url.protocol !== "file:" || url.host.length > 0) {
                return null;
            }
            return fileURLToPath(url);
        } catch {
            return null;
        }
    }
    if (!isAbsolute(trimmed) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
        return null;
    }
    return trimmed;
}

export async function readLocalRaster(uri: string, signal: AbortSignal): Promise<LocalRasterImage | null> {
    signal.throwIfAborted();
    const requested = parseLocalImageUri(uri);
    if (requested === null) {
        return null;
    }
    const target = await resolveCanonicalPath(requested, signal);
    if (target === null) {
        return null;
    }
    const targetMetadata = await readPathMetadata(target);
    signal.throwIfAborted();
    if (targetMetadata.kind !== "file" || targetMetadata.size < 1 || targetMetadata.size > MAX_LOCAL_RASTER_BYTES) {
        return null;
    }
    const header = await readFileStart(target, 12);
    signal.throwIfAborted();
    const mimeType = sniffRasterMime(header);
    if (mimeType === null) {
        return null;
    }
    return new LocalRasterImage(mimeType, target);
}
