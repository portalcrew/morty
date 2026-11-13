import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { isNodeError } from "../../engine/util/node-error.ts";

const LOG_FILE_NAME_PATTERN = /^[\w.-]{1,128}\.log$/u;
/** True when a path is legitimately absent, rather than present and unreadable. */
function isAbsent(cause: unknown): boolean {
    return typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "ENOENT";
}

/** Morty's private log directory, or null when it is absent or unreadable; an unreadable one joins `unreadable`. */
export async function findLogDirectory(
    root: string,
    unreadable: string[],
    signal: AbortSignal,
): Promise<string | null> {
    const computer = join(root, "computer");
    signal.throwIfAborted();
    const logs = join(computer, "logs");
    for (const path of [computer, logs]) {
        const status = await directoryStatus(path);
        if (status !== "listed") {
            if (status === "unreadable") {
                unreadable.push(relative(root, path));
            }
            return null;
        }
    }
    return logs;
}

/** The log file names in a log directory. An unreadable directory is added to `unreadable`, relative to `root`. */
export async function listLogFiles(directory: string, root: string, unreadable: string[]): Promise<readonly string[]> {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && LOG_FILE_NAME_PATTERN.test(entry.name))
            .map((entry) => entry.name)
            .sort();
    } catch (cause) {
        if (!isAbsent(cause)) {
            unreadable.push(relative(root, directory));
        }
        return [];
    }
}

type DirectoryStatus = "listed" | "skipped" | "unreadable";

/**
 * Classify a directory without changing it. Symlinks are rejected so a planted
 * link cannot redirect the report outside the state root, and the owner check
 * keeps another user's files out of it; both are deliberate exclusions rather
 * than collection failures.
 */
async function directoryStatus(path: string): Promise<DirectoryStatus> {
    let metadata: Stats;
    try {
        metadata = await lstat(path);
    } catch (cause) {
        return isAbsent(cause) ? "skipped" : "unreadable";
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownedByCurrentUser(metadata)) {
        return "skipped";
    }
    return "listed";
}

export type OwnedLogFileRead =
    | { readonly kind: "read"; readonly content: string }
    | { readonly kind: "skipped" }
    | { readonly kind: "unreadable" };

/** Reads a log file this user owns. Absent files, links and other users' files are skipped. */
export async function readOwnedLogFile(path: string, signal: AbortSignal): Promise<OwnedLogFileRead> {
    signal.throwIfAborted();
    let handle: FileHandle | undefined;
    try {
        // Pin the file before checking it. NONBLOCK also keeps a raced-in FIFO from hanging collection.
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const metadata = await handle.stat({ bigint: true });
        const current = await lstat(path, { bigint: true });
        // The path check preserves link rejection on platforms without O_NOFOLLOW.
        if (
            !metadata.isFile() ||
            !ownedByCurrentUser(metadata) ||
            current.isSymbolicLink() ||
            current.dev !== metadata.dev ||
            current.ino !== metadata.ino
        ) {
            return { kind: "skipped" };
        }
        return { kind: "read", content: await handle.readFile({ encoding: "utf8", signal }) };
    } catch (cause) {
        // Cancellation is not evidence about the file: let it propagate so the
        // command fails as aborted rather than reporting a healthy log as broken.
        if (signal.aborted) {
            throw cause;
        }
        if (isAbsent(cause) || isNodeError(cause, "ELOOP")) {
            return { kind: "skipped" };
        }
        return { kind: "unreadable" };
    } finally {
        await handle?.close();
    }
}

function ownedByCurrentUser(metadata: { readonly uid: number | bigint }): boolean {
    // Windows reports uid 0 for every file, so ownership is not a signal there.
    return process.getuid === undefined || BigInt(metadata.uid) === BigInt(process.getuid());
}
