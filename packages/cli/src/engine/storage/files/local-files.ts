import { constants, type Dirent, type Stats } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

function pathMetadata(metadata: Stats): LocalPathMetadata {
    return {
        kind: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
        modifiedAt: metadata.mtime,
        modifiedMilliseconds: metadata.mtimeMs,
        size: metadata.size,
    };
}

// macOS and Windows name files case-insensitively by default, so a differently cased path names the same file.
export const foldPathCase = (path: string): string =>
    process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;

/** Whether a canonical path is the directory or lies inside it, compared against the directory's canonical path. */
export async function isWithinDirectory(path: string, directory: string): Promise<boolean> {
    const root = await realpath(directory).catch(() => resolve(directory));
    const inside = relative(foldPathCase(root), foldPathCase(path));
    return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

export async function readPathMetadata(path: string): Promise<LocalPathMetadata> {
    return pathMetadata(await stat(path));
}

/** A regular file opened once: every read comes from the opened file, so the file checked is the file read. */
export interface OpenedLocalFile extends AsyncDisposable {
    readonly metadata: LocalPathMetadata;
    readonly readStart: (byteLength: number) => Promise<Uint8Array>;
    readonly chunks: (chunkBytes: number, signal: AbortSignal) => AsyncIterable<Uint8Array>;
    readonly currentMetadata: () => Promise<LocalPathMetadata>;
}

// The open follows no link in the last component and cannot block on a FIFO; a platform without a flag lacks it.
const OPEN_FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Opens the regular file a canonical path names, or answers null. A directory replaced by a link after the path was
 * resolved could lead the open to another file, so the path must still resolve to itself and name the opened file.
 */
export async function openCanonicalFile(path: string): Promise<OpenedLocalFile | null> {
    const handle = await open(path, OPEN_FILE_FLAGS);
    try {
        const opened = await handle.stat();
        const named = (await realpath(path)) === path ? await stat(path) : null;
        if (!opened.isFile() || named === null || named.dev !== opened.dev || named.ino !== opened.ino) {
            await handle.close();
            return null;
        }
        const metadata = pathMetadata(opened);
        return {
            metadata,
            readStart: async (byteLength) => {
                const bytes = new Uint8Array(Math.min(byteLength, metadata.size));
                await handle.read(bytes, 0, bytes.byteLength, 0);
                return bytes;
            },
            chunks: (chunkBytes, signal) =>
                handle.createReadStream({
                    autoClose: false,
                    start: 0,
                    end: Math.max(0, metadata.size - 1),
                    highWaterMark: chunkBytes,
                    signal,
                }),
            currentMetadata: async () => pathMetadata(await handle.stat()),
            [Symbol.asyncDispose]: async () => await handle.close(),
        };
    } catch (cause) {
        await handle.close();
        throw cause;
    }
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
