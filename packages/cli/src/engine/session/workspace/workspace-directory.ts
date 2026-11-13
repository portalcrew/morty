import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { isDirectoryPath, type WorkspaceEntry } from "@morty-build/client/protocol";
import { canonicalPath, listDirectory, readPathMetadata } from "../../storage/files/local-files.ts";
import { LocalAuthorizationError } from "./local-authorization-error.ts";

export class WorkspaceDirectoryListing {
    readonly directory: string;
    readonly directoryLabel: string;
    readonly entries: readonly WorkspaceEntry[];
    readonly parentDirectory: string;
    constructor(
        directory: string,
        directoryLabel: string,
        entries: readonly WorkspaceEntry[],
        parentDirectory: string,
    ) {
        this.directory = directory;
        this.directoryLabel = directoryLabel;
        this.entries = entries;
        this.parentDirectory = parentDirectory;
    }
}

function expandCurrentUserHome(path: string): string {
    // Adapted from https://github.com/sindresorhus/untildify/blob/main/index.js.
    return path.replace(/^~(?=$|\/|\\)/, homedir());
}

/** Pairing authorizes the computer. Explicit paths select a working
 * directory; they do not grant additional filesystem capabilities. */
export class WorkspaceDirectoryService {
    readonly #defaultWorkspace: string;

    constructor(defaultWorkspace: string) {
        this.#defaultWorkspace = defaultWorkspace;
    }

    private readonly requestedPath = (directory: string): string => {
        if (!isDirectoryPath(directory)) {
            throw new LocalAuthorizationError("The directory path is invalid");
        }
        return resolve(this.#defaultWorkspace, expandCurrentUserHome(directory));
    };

    private readonly resolvePath = async (requested: string, signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        if (!isDirectoryPath(requested) || !isAbsolute(requested) || normalize(requested) !== requested) {
            throw new LocalAuthorizationError("The local directory path is invalid");
        }
        try {
            const target = await canonicalPath(requested);
            signal.throwIfAborted();
            const metadata = await readPathMetadata(target);
            signal.throwIfAborted();
            if (
                !isDirectoryPath(target) ||
                !isAbsolute(target) ||
                normalize(target) !== target ||
                metadata.kind !== "directory"
            ) {
                throw new LocalAuthorizationError("The selected location is not a directory");
            }
            return target;
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof LocalAuthorizationError) {
                throw cause;
            }
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
                // Return only the caller's selection, never raw filesystem diagnostics or resolved targets.
                // Failure messages must fit the existing 500-character protocol limit on every platform.
                const quoted = JSON.stringify(requested);
                const selection = quoted.length <= 350 ? `The directory ${quoted}` : "The selected directory";
                throw new LocalAuthorizationError(
                    `${selection} does not exist. Choose an existing directory or create it locally before retrying.`,
                    { cause },
                );
            }
            throw new LocalAuthorizationError("This directory is missing or unavailable to your user account", {
                cause,
            });
        }
    };

    private readonly label = (path: string): string => {
        const suffix = relative(homedir(), path);
        return suffix === ""
            ? "~"
            : !isAbsolute(suffix) &&
                suffix !== ".." &&
                !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
              ? `~/${suffix.replaceAll("\\", "/")}`
              : path;
    };

    readonly identify = async (
        requestedPath: string,
        signal: AbortSignal,
    ): Promise<{
        readonly path: string;
        readonly directory: string;
        readonly name: string;
        readonly label: string;
    }> => {
        const path = await this.resolvePath(requestedPath, signal);
        return {
            path,
            directory: path,
            name: basename(path) || path,
            label: this.label(path),
        };
    };

    /**
     * Names a directory a Session recorded when it was resolved, without reading the filesystem. A Session
     * keeps its identity after its directory is moved, deleted or unmounted; using the Session resolves the
     * directory again and fails there.
     */
    readonly identifyRecorded = (
        recordedPath: string,
    ): { readonly directory: string; readonly name: string; readonly label: string } => {
        if (!isDirectoryPath(recordedPath) || !isAbsolute(recordedPath) || normalize(recordedPath) !== recordedPath) {
            throw new LocalAuthorizationError("The recorded directory path is invalid");
        }
        return {
            directory: recordedPath,
            name: basename(recordedPath) || recordedPath,
            label: this.label(recordedPath),
        };
    };

    readonly resolve = async (directory: string, signal: AbortSignal): Promise<string> => {
        return await this.resolvePath(this.requestedPath(directory), signal);
    };

    readonly describe = async (
        directory: string,
        signal: AbortSignal,
    ): Promise<{ readonly path: string; readonly label: string; readonly parentDirectory: string }> => {
        const path = await this.resolve(directory, signal);
        const parent = dirname(path);
        return { path, label: this.label(path), parentDirectory: parent === path ? "" : parent };
    };

    readonly list = async (directory: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing> => {
        const target = await this.resolve(directory, signal);
        try {
            const children = await listDirectory(target);
            signal.throwIfAborted();
            const entries: WorkspaceEntry[] = [];
            for (const child of children) {
                if (entries.length === 500) {
                    break;
                }
                if (
                    child.kind === "file" ||
                    child.kind === "device" ||
                    child.kind === "fifo" ||
                    child.kind === "socket"
                ) {
                    continue;
                }
                try {
                    const path = await this.resolvePath(join(target, child.name), signal);
                    entries.push({ directory: path, name: child.name });
                } catch (cause) {
                    signal.throwIfAborted();
                    if (!(cause instanceof LocalAuthorizationError)) {
                        throw cause;
                    }
                }
            }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            const parent = dirname(target);
            return new WorkspaceDirectoryListing(target, this.label(target), entries, parent === target ? "" : parent);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof LocalAuthorizationError) {
                throw cause;
            }
            throw new LocalAuthorizationError("This directory cannot be browsed by your user account", { cause });
        }
    };
}
