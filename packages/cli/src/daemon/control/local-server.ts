import { createServer, type Socket } from "node:net";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { hostPlatform as platform } from "../../engine/util/platform/index.ts";
import { readOrCreateControlToken } from "../../storage/daemon/control-token.ts";
import { controlSocketPath, readSocketMessage } from "./local-client.ts";

export async function serveLocalControl(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
    handle: (request: unknown, signal: AbortSignal) => Promise<unknown>,
    onResponse: (response: unknown) => void = () => undefined,
): Promise<void> {
    signal.throwIfAborted();
    const token = await readOrCreateControlToken(stateDirectory);
    const path = controlSocketPath(stateDirectory);
    const secured = Promise.withResolvers<void>();
    void secured.promise.catch(() => undefined);
    const sockets = new Set<Socket>();
    const requests = new Set<Promise<void>>();
    const serve = async (socket: Socket): Promise<void> => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(130_000)]);
        try {
            await secured.promise;
            const request = await readSocketMessage(socket, deadline);
            if (typeof request !== "object" || request === null || !("token" in request) || request.token !== token) {
                socket.end(
                    `${JSON.stringify({ kind: "error", code: "unauthorized", message: "Invalid local control token" })}\n`,
                );
                return;
            }
            const response = await handle(request, deadline);
            socket.end(`${JSON.stringify(response)}\n`, () => onResponse(response));
        } catch {
            if (!signal.aborted && !socket.destroyed && !socket.writableEnded) {
                socket.end(
                    `${JSON.stringify({ kind: "error", code: "control_request_failed", message: "Local control request failed" })}\n`,
                );
            }
        }
    };
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        const request = serve(socket);
        requests.add(request);
        void request.finally(() => requests.delete(request));
    });
    try {
        await platform.prepareControlSocket(path);
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
            // Bind with private permissions immediately; clients may arrive before the explicit chmod below.
            const previousMask = process.umask(0o077);
            try {
                server.listen(path);
            } finally {
                process.umask(previousMask);
            }
        });
        await platform.secureControlSocket(path, signal);
        secured.resolve();
        if (!signal.aborted) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
    } finally {
        secured.reject(new Error("Local control server stopped before becoming ready"));
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.allSettled(requests);
        await platform.removeControlSocket(path).catch(() => undefined);
    }
}
