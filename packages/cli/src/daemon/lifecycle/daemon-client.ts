import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { daemonLockExists } from "../../storage/daemon/daemon-lock.ts";
import { CONTROL_TIMEOUT_MILLISECONDS, sendLocalRequest } from "../control/local-client.ts";
import { decodeLifecycleResponse } from "../control/protocol.ts";

async function spawnDaemon(entry: string, environment: Readonly<NodeJS.ProcessEnv>): Promise<ChildProcess> {
    const child = spawn(process.execPath, [entry, "__daemon"], {
        detached: true,
        windowsHide: true,
        env: environment,
        stdio: "ignore",
    });
    await once(child, "spawn");
    child.unref();
    return child;
}

async function waitForDaemonExit(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    while (!deadline.aborted) {
        if (!(await daemonLockExists(stateDirectory))) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(finish, 20);
            const abort = (): void => finish(deadline.reason);
            function finish(cause?: unknown): void {
                clearTimeout(timeout);
                deadline.removeEventListener("abort", abort);
                cause === undefined ? resolve() : reject(cause);
            }
            deadline.addEventListener("abort", abort, { once: true });
        });
    }
    throw deadline.reason;
}

/** The daemon serving an installation, and whether this call started it. */
export interface RunningDaemon {
    readonly version: string;
    readonly started: boolean;
}

// A new daemon runs the same package as its invoking command, in the environment the caller names.
export async function ensureDaemon(
    stateDirectory: InstallationDirectory,
    entry: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<RunningDaemon> {
    const running = await readDaemonVersion(stateDirectory, signal);
    if (running !== null) {
        return { version: running, started: false };
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    return await waitForDaemon(stateDirectory, entry, environment, deadline);
}

// Status identifies the currently running daemon.
export async function readDaemonVersion(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
): Promise<string | null> {
    try {
        const response = decodeLifecycleResponse(await sendLocalRequest(stateDirectory, { kind: "status" }, signal));
        if (response.kind === "status") {
            return response.daemon.version;
        }
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
            throw cause;
        }
    }
    return null;
}

async function waitForDaemon(
    stateDirectory: InstallationDirectory,
    entry: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<RunningDaemon> {
    let daemonStarted = false;
    let child: ChildProcess | undefined;
    while (!signal.aborted) {
        try {
            const response = decodeLifecycleResponse(
                await sendLocalRequest(stateDirectory, { kind: "status" }, signal),
            );
            if (response.kind === "error") {
                throw new Error(response.message);
            }
            if (response.kind === "status") {
                return { version: response.daemon.version, started: daemonStarted };
            }
            throw new Error("The daemon could not return its status");
        } catch (cause) {
            if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
                throw cause;
            }
            // A competing launcher can exit successfully after losing the lock.
            // Check the shared endpoint first and keep waiting for its owner.
            if (
                child !== undefined &&
                (child.signalCode !== null ||
                    (child.exitCode !== null && (child.exitCode !== 0 || !(await daemonLockExists(stateDirectory)))))
            ) {
                throw new Error("The daemon exited before becoming ready");
            }
            if (!daemonStarted) {
                child = await spawnDaemon(entry, environment);
                daemonStarted = true;
            }
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(finish, 50);
                const abort = (): void => finish(signal.reason);
                function finish(cause?: unknown): void {
                    clearTimeout(timeout);
                    signal.removeEventListener("abort", abort);
                    cause === undefined ? resolve() : reject(cause);
                }
                signal.addEventListener("abort", abort, { once: true });
            });
        }
    }
    throw signal.reason;
}

export async function stopDaemon(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    while (true) {
        deadline.throwIfAborted();
        try {
            const response = decodeLifecycleResponse(
                await sendLocalRequest(stateDirectory, { kind: "stop" }, deadline),
            );
            if (response.kind === "error") {
                throw new Error(response.message);
            }
            if (response.kind !== "stopped") {
                throw new Error("The Morty daemon returned an unexpected response");
            }
            await waitForDaemonExit(stateDirectory, deadline);
            return;
        } catch (cause) {
            deadline.throwIfAborted();
            if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
                throw cause;
            }
            if (!(await daemonLockExists(stateDirectory))) {
                return;
            }
            // The owner may still be copying data or discovering Agents. Its missing
            // socket is not proof of shutdown: wait for control or report the deadline.
            await delay(50, undefined, { signal: deadline });
        }
    }
}
