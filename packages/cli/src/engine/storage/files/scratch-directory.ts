import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

async function atomicWrite(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, bytes, { mode: 0o600, signal });
        signal.throwIfAborted();
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

/**
 * A private directory that one process owns under a shared parent. The owner refreshes its lease, so
 * any owner can remove the directories a crashed process left behind without touching a running one.
 */
export class ScratchDirectory {
    readonly #root: string;

    constructor(parent: string) {
        this.#root = join(parent, randomUUID());
    }

    readonly refreshLease = async (leaseMilliseconds: number): Promise<void> => {
        await mkdir(this.#root, { mode: 0o700, recursive: true });
        const now = new Date();
        await utimes(this.#root, now, now);
        for (const directory of await readdir(dirname(this.#root), { withFileTypes: true })) {
            if (!directory.isDirectory() || !/^[a-f0-9-]{36}$/u.test(directory.name)) {
                continue;
            }
            const path = join(dirname(this.#root), directory.name);
            if (path === this.#root) {
                continue;
            }
            // Another process may remove its own directory during this scan.
            const modified = await stat(path).then(
                (entry) => entry.mtimeMs,
                () => Date.now(),
            );
            if (modified + leaseMilliseconds <= Date.now()) {
                await rm(path, { force: true, recursive: true });
            }
        }
    };

    readonly write = async (group: string, name: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> => {
        const directory = join(this.#root, group);
        await mkdir(directory, { mode: 0o700, recursive: true });
        signal.throwIfAborted();
        const path = join(directory, name);
        await atomicWrite(path, bytes, signal);
        return path;
    };

    readonly remove = async (path: string): Promise<void> => {
        await rm(path, { force: true });
    };

    readonly resolveFile = async (path: string): Promise<string | null> => {
        try {
            const [resolvedDirectory, resolvedPath, file] = await Promise.all([
                realpath(dirname(path)),
                realpath(path),
                lstat(path),
            ]);
            return file.isFile() && !file.isSymbolicLink() && dirname(resolvedPath) === resolvedDirectory
                ? resolvedPath
                : null;
        } catch {
            return null;
        }
    };

    readonly read = async (path: string, signal: AbortSignal): Promise<Uint8Array | null> => {
        const resolved = await this.resolveFile(path);
        signal.throwIfAborted();
        return resolved === null ? null : new Uint8Array(await readFile(resolved, { signal }));
    };

    readonly removeAll = async (): Promise<void> => {
        await rm(this.#root, { force: true, recursive: true });
    };
}
