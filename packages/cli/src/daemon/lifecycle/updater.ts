import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { mortyReleaseVersionSchema } from "@portalcrew/morty-client/protocol";
import { z } from "zod";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { BoundedLineLog } from "../../engine/storage/logs/bounded-log.ts";
import { DAEMON_LIFECYCLE_LOG_FILENAME, logDirectory } from "../../engine/storage/logs/log-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { runBoundedProcess } from "../../engine/util/process/executable.ts";
import { daemonLockExists } from "../../storage/daemon/daemon-lock.ts";
import { CONTROL_TIMEOUT_MILLISECONDS, sendLocalRequest } from "../control/local-client.ts";
import { openMortyInstallation } from "../pairing/pair-local-computer.ts";
import { ensureDaemon } from "./daemon-client.ts";
import { findNpx, MORTY_PACKAGE_NAME, recordUpdate } from "./daemon-update.ts";

const PREVIOUS_DAEMON_EXIT_MILLISECONDS = 120_000;
const NEXT_DAEMON_START_MILLISECONDS = 180_000;

// Any later release answers status with its version; read only that, so a newer control protocol is not a failure.
const runningDaemonStatus = z.object({ kind: z.literal("status"), daemon: z.object({ version: z.string() }) });

/**
 * Starts `version` once the daemon that spawned this updater has stopped, and starts this release again when the
 * new one does not come up, so the Computer is never left without a daemon.
 */
export async function runUpdater(version: string, entry: string, signal: AbortSignal): Promise<void> {
    const target = mortyReleaseVersionSchema.parse(version);
    const control = await openMortyInstallation(signal, process.env);
    const stateDirectory = control.stateDirectory;
    const log = new BoundedLineLog(logDirectory(stateDirectory), DAEMON_LIFECYCLE_LOG_FILENAME, 512 * 1024);
    if (!(await previousDaemonStopped(stateDirectory, signal))) {
        recordUpdate(log, "daemon_update_abandoned", { to: target, reason: "previous_daemon_running" });
        return;
    }
    try {
        await runBoundedProcess({
            command: await findNpx(),
            arguments: ["--yes", `${MORTY_PACKAGE_NAME}@${target}`, "start"],
            cwd: homedir(),
            environment: process.env,
            signal,
            timeoutMilliseconds: NEXT_DAEMON_START_MILLISECONDS,
        });
    } catch {
        signal.throwIfAborted();
        recordUpdate(log, "daemon_update_start_failed", { to: target });
    }
    const running = await runningDaemonVersion(stateDirectory, signal);
    if (running === target) {
        recordUpdate(log, "daemon_updated", { to: target });
        return;
    }
    if (running !== null) {
        recordUpdate(log, "daemon_update_failed", { to: target, running });
        return;
    }
    const restored = await ensureDaemon(stateDirectory, entry, process.env, signal);
    recordUpdate(log, "daemon_update_rolled_back", { to: target, running: restored.version });
}

async function previousDaemonStopped(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<boolean> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(PREVIOUS_DAEMON_EXIT_MILLISECONDS)]);
    while (await daemonLockExists(stateDirectory)) {
        try {
            await delay(100, undefined, { signal: deadline });
        } catch (cause) {
            signal.throwIfAborted();
            if (deadline.aborted) {
                return false;
            }
            throw cause;
        }
    }
    return true;
}

async function runningDaemonVersion(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
): Promise<string | null> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    try {
        const status = runningDaemonStatus.safeParse(
            await sendLocalRequest(stateDirectory, { kind: "status" }, deadline),
        );
        return status.success ? status.data.daemon.version : "unknown";
    } catch (cause) {
        if (isNodeError(cause, "ENOENT") || isNodeError(cause, "ECONNREFUSED")) {
            return null;
        }
        throw cause;
    }
}
