import { createReadStream, type Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises";

type LocalPathKind = "directory" | "file" | "other";

export interface LocalPathMetadata {
    readonly kind: LocalPathKind;
    readonly modifiedAt: Date;
    readonly modifiedMilliseconds: number;
    readonly size: number;
}

/** What a directory entry is, without following symbolic links. */
type LocalDirectoryEntryKind = "directory" | "file" | "symbolic-link" | "device" | "fifo" | "socket" | "unknown";

export interface LocalDirectoryEntry {
    readonly kind: LocalDirectoryEntryKind;
    readonly name: string;
}

function entryKind(entry: Dirent): LocalDirectoryEntryKind {
    if (entry.isDirectory()) {
        return "directory";
    }
    if (entry.isFile()) {
        return "file";
    }
    if (entry.isSymbolicLink()) {
        return "symbolic-link";
    }
    if (entry.isBlockDevice() || entry.isCharacterDevice()) {
        return "device";
    }
    if (entry.isFIFO()) {
        return "fifo";
    }
    return entry.isSocket() ? "socket" : "unknown";
}

export async function canonicalPath(path: string): Promise<string> {
    return await realpath(path);
}

export async function readPathMetadata(path: string): Promise<LocalPathMetadata> {
    const metadata = await stat(path);
    return {
        kind: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
        modifiedAt: metadata.mtime,
        modifiedMilliseconds: metadata.mtimeMs,
        size: metadata.size,
    };
}

export async function listDirectory(path: string): Promise<readonly LocalDirectoryEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ kind: entryKind(entry), name: entry.name }));
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { mode: 0o700, recursive: true });
}

export async function ensureCanonicalDirectory(path: string): Promise<string | null> {
    await ensurePrivateDirectory(path);
    const resolved = await realpath(path);
    return (await stat(resolved)).isDirectory() ? resolved : null;
}

export async function readFileStart(path: string, byteLength: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(byteLength);
    const handle = await open(path, "r");
    try {
        await handle.read(bytes, 0, byteLength, 0);
    } finally {
        await handle.close();
    }
    return bytes;
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
    return await readFile(path);
}

export function readFileChunks(path: string, chunkBytes: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
    return createReadStream(path, { highWaterMark: chunkBytes, signal });
}
