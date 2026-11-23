import { lstat, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import WebSocket from "ws";
import { z } from "zod";
import type { CodexAppServerClient } from "./app-server-client.ts";

/** Only probe the Codex installation's private per-user endpoint. Never create or start a daemon. */
export async function connectSharedCodex(environment: Readonly<Record<string, string>>, signal: AbortSignal) {
    const uid = process.getuid?.();
    if (uid === undefined) {
        return null;
    }
    const home =
        environment["CODEX_HOME"] ?? process.env["CODEX_HOME"] ?? join(environment["HOME"] ?? homedir(), ".codex");
    if (!isAbsolute(home)) {
        return null;
    }
    const directory = join(home, "app-server-control");
    const path = join(directory, "app-server-control.sock");
    const dir = await lstat(directory).catch(() => null);
    if (!dir?.isDirectory() || dir.uid !== uid || (dir.mode & 0o022) !== 0) {
        return null;
    }
    // Codex may publish a symlink here to fit the platform's Unix socket path limit.
    const endpoint = await realpath(path).catch(() => null);
    if (endpoint === null) {
        return null;
    }
    const parent = await lstat(dirname(endpoint)).catch(() => null);
    if (!parent?.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0) {
        return null;
    }
    const file = await lstat(endpoint).catch(() => null);
    if (!file?.isSocket() || file.uid !== uid) {
        return null;
    }
    signal.throwIfAborted();
    const socket = new WebSocket("ws://localhost/rpc", {
        createConnection: () => connect(endpoint),
        handshakeTimeout: 1500,
        maxPayload: 32 * 1024 * 1024,
        perMessageDeflate: false,
    });
    const abort = () => socket.terminate();
    signal.addEventListener("abort", abort, { once: true });
    try {
        return await new Promise<WebSocket | null>((resolve) => {
            socket.once("open", () => resolve(socket));
            socket.once("error", () => resolve(null));
        });
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

const loadedPage = z.object({ data: z.array(z.string()), nextCursor: z.string().nullish() });

export async function sharedServerOwns(
    client: CodexAppServerClient,
    threadId: string,
    cwd: string,
    signal: AbortSignal,
) {
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
        const page = loadedPage.parse(await client.request("thread/loaded/list", { cursor, limit: 100 }, signal));
        if (page.data.includes(threadId)) {
            const response = z
                .object({ thread: z.object({ id: z.literal(threadId), cwd: z.string() }) })
                .parse(await client.request("thread/read", { threadId, includeTurns: false }, signal));
            return (await realpath(response.thread.cwd)) === (await realpath(cwd));
        }
        cursor = page.nextCursor ?? null;
        if (cursor === null || cursors.has(cursor)) {
            return false;
        }
        cursors.add(cursor);
    }
}
