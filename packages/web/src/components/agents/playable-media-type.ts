export interface PlayableMedia {
    readonly kind: "video" | "audio";
    readonly mediaType: string;
}

function startsWith(bytes: Uint8Array, offset: number, signature: string): boolean {
    if (bytes.byteLength < offset + signature.length) {
        return false;
    }
    for (let index = 0; index < signature.length; index += 1) {
        if (bytes[offset + index] !== signature.charCodeAt(index)) {
            return false;
        }
    }
    return true;
}

function includesWithin(bytes: Uint8Array, limit: number, text: string): boolean {
    for (let offset = 0; offset + text.length <= Math.min(bytes.byteLength, limit); offset += 1) {
        if (startsWith(bytes, offset, text)) {
            return true;
        }
    }
    return false;
}

/**
 * The media a browser can play from these bytes, recognized by the container's signature rather than the file's
 * name or a type a peer reported. Other media, such as QuickTime or Matroska, is only downloaded.
 */
export function playableMediaType(bytes: Uint8Array): PlayableMedia | null {
    if (startsWith(bytes, 4, "ftyp")) {
        return startsWith(bytes, 8, "M4A ") || startsWith(bytes, 8, "M4B ")
            ? { kind: "audio", mediaType: "audio/mp4" }
            : startsWith(bytes, 8, "qt  ")
              ? null
              : { kind: "video", mediaType: "video/mp4" };
    }
    if (startsWith(bytes, 0, "\u001aEß£")) {
        return includesWithin(bytes, 64, "webm") ? { kind: "video", mediaType: "video/webm" } : null;
    }
    if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WAVE")) {
        return { kind: "audio", mediaType: "audio/wav" };
    }
    if (startsWith(bytes, 0, "OggS")) {
        return { kind: "audio", mediaType: "audio/ogg" };
    }
    if (startsWith(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2)) {
        return { kind: "audio", mediaType: "audio/mpeg" };
    }
    return null;
}
