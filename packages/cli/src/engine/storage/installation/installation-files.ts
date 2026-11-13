import { randomUUID } from "node:crypto";
import { type FileHandle, link, mkdir, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isNodeError } from "../../util/node-error.ts";

const MAXIMUM_FILE_BYTES = 16 * 1024;

const installationDirectorySchema = z.string().brand<"InstallationDirectory">();

/** The private directory containing daemon data. */
export type InstallationDirectory = z.infer<typeof installationDirectorySchema>;

export function installationDirectory(engineDataDir: string): InstallationDirectory {
    return installationDirectorySchema.parse(engineDataDir);
}

export type InstallationFileRead =
    | { readonly kind: "read"; readonly text: string }
    | { readonly kind: "missing"; readonly cause: unknown }
    | { readonly kind: "unopenable"; readonly cause: unknown }
    | { readonly kind: "not-a-small-file" };

/** Reads a small regular file. Errors after the file is open propagate. */
export async function readInstallationFile(
    path: string,
    maximumBytes = MAXIMUM_FILE_BYTES,
): Promise<InstallationFileRead> {
    let handle: FileHandle;
    try {
        handle = await open(path, "r");
    } catch (cause) {
        return isNodeError(cause, "ENOENT") ? { kind: "missing", cause } : { kind: "unopenable", cause };
    }
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > maximumBytes) {
            return { kind: "not-a-small-file" };
        }
        return { kind: "read", text: await handle.readFile({ encoding: "utf8" }) };
    } finally {
        await handle.close();
    }
}

/** Replaces a file atomically with owner-only permissions, creating its directory when it is missing. */
/**
 * Replaces a file with `text` durably: the new content reaches the disk before it replaces the old, and the rename
 * reaches the disk before this returns. A credential the Relay has already rotated must survive a crash or power loss.
 */
export async function writeInstallationFile(path: string, text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
    try {
        await mkdir(directory, { mode: 0o700, recursive: true });
        signal.throwIfAborted();
        const file = await open(temporaryPath, "wx", 0o600);
        try {
            await file.writeFile(text);
            await file.sync();
        } finally {
            await file.close();
        }
        signal.throwIfAborted();
        await rename(temporaryPath, path);
        await syncDirectory(directory);
    } catch (cause) {
        await unlink(temporaryPath).catch(() => undefined);
        throw cause;
    }
}

/** Flushes a rename in `directory`. Windows cannot open a directory to flush it; NTFS journals the rename itself. */
async function syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") {
        return;
    }
    const handle = await open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * Publishes a complete file with owner-only permissions. Fails with `EEXIST` when it already exists.
 * A concurrent reader sees either no file or the whole text, never an empty or partial one.
 */
export async function createInstallationFile(path: string, text: string): Promise<void> {
    const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryPath, text, { flag: "wx", mode: 0o600 });
        await link(temporaryPath, path);
    } finally {
        await rm(temporaryPath, { force: true });
    }
}
