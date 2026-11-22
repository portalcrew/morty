import { basename, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    CONTENT_CHUNK_MAX_BYTES,
    type decodeFileBeginEvent,
    type decodeFileEndEvent,
    FILE_BEGIN_KIND,
    FILE_END_KIND,
    type FileReadCommand,
} from "@portalcrew/morty-client/protocol";
import { isMortyStatePath } from "../../../storage/state-root.ts";
import { localRasterMimeType } from "../../acp/content/raster.ts";
import { canonicalPath, openCanonicalFile } from "../../storage/files/local-files.ts";
import { SessionError } from "../api/session-error.ts";
import type { ExternalContentStore } from "./external-content-store.ts";

type RequestedFileTarget =
    | { readonly explicitUrl: true; readonly path: string }
    | { readonly explicitUrl: false; readonly path: string };

function requestedPath(value: string): RequestedFileTarget | null {
    if (value.includes("\0")) {
        return null;
    }
    if (value.startsWith("file:")) {
        try {
            const url = new URL(value);
            return url.protocol === "file:" && url.host.length === 0
                ? { explicitUrl: true, path: fileURLToPath(url) }
                : null;
        } catch {
            return null;
        }
    }
    return { explicitUrl: false, path: value };
}

async function resolveFile(
    value: string,
    workingDirectory: string | null,
    signal: AbortSignal,
): Promise<string | null> {
    const requested = requestedPath(value);
    if (requested === null || (!isAbsolute(requested.path) && workingDirectory === null)) {
        return null;
    }
    if (isAbsolute(requested.path) && normalize(requested.path) !== requested.path) {
        return null;
    }
    // Agents link their output with workspace-root-relative references such as
    // "/index.html", which collide with computer-absolute paths. Interpret a
    // plain reference against the session working directory first, and fall
    // back to the computer-absolute interpretation, so both keep resolving. An
    // explicit file URL always means its computer-absolute target.
    const candidates =
        requested.explicitUrl || workingDirectory === null
            ? [requested.path]
            : isAbsolute(requested.path)
              ? [join(workingDirectory, requested.path), requested.path]
              : [resolve(workingDirectory, requested.path)];
    for (const candidate of candidates) {
        if (!isAbsolute(candidate) || normalize(candidate) !== candidate) {
            continue;
        }
        try {
            const target = await canonicalPath(candidate);
            signal.throwIfAborted();
            if (isAbsolute(target) && normalize(target) === target) {
                return target;
            }
        } catch {
            signal.throwIfAborted();
        }
    }
    return null;
}

export async function streamLocalFile({
    command,
    sendBegin,
    sendEnd,
    sendChunk,
    takeCredit,
    signal,
    workingDirectory,
    externalContent,
    stateDirectory,
}: {
    readonly command: FileReadCommand;
    readonly sendBegin: (message: ReturnType<typeof decodeFileBeginEvent>) => Promise<void>;
    readonly sendEnd: (message: ReturnType<typeof decodeFileEndEvent>) => Promise<void>;
    readonly sendChunk: (requestId: string, sequence: number, bytes: Uint8Array) => Promise<void>;
    readonly takeCredit: (signal: AbortSignal) => Promise<void>;
    readonly signal: AbortSignal;
    readonly workingDirectory: string | null;
    readonly externalContent: ExternalContentStore;
    readonly stateDirectory: string;
}): Promise<{ readonly byteLength: number }> {
    const external = await externalContent.resolve(command.target, command.path, signal);
    const target =
        external === null
            ? await resolveFile(command.path, workingDirectory, signal)
            : await canonicalPath(external.path);
    signal.throwIfAborted();
    if (target === null) {
        throw new Error("The local file is unavailable");
    }
    // Morty's state holds the Computer's credentials and keys, which no Session file read may serve. Content the store
    // keeps for Sessions lies there too, and Agents reference it by path.
    if (
        external === null &&
        (await isMortyStatePath(target, stateDirectory)) &&
        !(await externalContent.holds(target))
    ) {
        throw new SessionError("morty_state_unavailable", "Morty's own state is not a Session file");
    }
    await using opened = await openCanonicalFile(target);
    signal.throwIfAborted();
    if (opened === null) {
        throw new Error("The local file is unavailable");
    }
    const before = opened.metadata;
    if (before.size < 1) {
        throw new Error("The local file is unavailable");
    }
    if (before.size > command.maxBytes) {
        throw new SessionError("file_too_large", "The local file is larger than the read allows");
    }
    const raster = external === null ? localRasterMimeType(await opened.readStart(12), before.size) : null;
    signal.throwIfAborted();
    await sendBegin({
        byteLength: before.size,
        kind: FILE_BEGIN_KIND,
        mediaType:
            external?.mediaType ??
            raster ??
            (extname(target).toLowerCase() === ".svg" ? "image/svg+xml" : "application/octet-stream"),
        modifiedAt: before.modifiedAt.toISOString(),
        name: external?.name ?? (basename(target) || "file"),
        requestId: command.requestId,
        target: command.target,
    });
    let sequence = 0;
    const chunks = opened.chunks(CONTENT_CHUNK_MAX_BYTES, signal)[Symbol.asyncIterator]();
    try {
        while (true) {
            signal.throwIfAborted();
            await takeCredit(signal);
            signal.throwIfAborted();
            const next = await chunks.next();
            if (next.done) {
                break;
            }
            await sendChunk(command.requestId, sequence, next.value);
            sequence += 1;
        }
    } finally {
        await chunks.return?.();
    }
    const after = await opened.currentMetadata();
    signal.throwIfAborted();
    if (after.size !== before.size || after.modifiedMilliseconds !== before.modifiedMilliseconds) {
        throw new Error("The local file changed during transfer");
    }
    await sendEnd({
        kind: FILE_END_KIND,
        requestId: command.requestId,
        target: command.target,
    });
    return { byteLength: before.size };
}
