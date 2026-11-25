import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { COMPUTER_UPDATE_TIMEOUT_MILLISECONDS, isNewerMortyRelease } from "@portalcrew/morty-client/protocol";
import { OperationError } from "../../engine/infra/operation-error.ts";
import type { ComputerUpdate } from "../../engine/runtime/computer-update.ts";
import type { AgentProcessPool } from "../../engine/session/process/agent-process-pool.ts";
import type { BoundedLineLog } from "../../engine/storage/logs/bounded-log.ts";
import { findExecutableOnPath, runBoundedProcess } from "../../engine/util/process/executable.ts";
import { waitForSharedOperation } from "../../engine/util/wait-for-shared-operation.ts";

export const MORTY_PACKAGE_NAME = "@portalcrew/morty";
// A slow download is refused before the request's own deadline, so the page never mistakes it for a restart.
const RELEASE_DOWNLOAD_TIMEOUT_MILLISECONDS = COMPUTER_UPDATE_TIMEOUT_MILLISECONDS - 20_000;

export interface DaemonUpdateOptions {
    readonly version: string;
    readonly entry: string;
    readonly processes: AgentProcessPool;
    readonly lifecycleLog: BoundedLineLog;
    readonly stop: () => void;
}

export async function findNpx(): Promise<string> {
    const npx = await findExecutableOnPath("npx", process.env);
    if (npx === null) {
        throw new OperationError("update_npx_unavailable", "This computer has no npx to download Morty with.");
    }
    return npx.path;
}

export function recordUpdate(log: BoundedLineLog, kind: string, details: Readonly<Record<string, string>>): void {
    log.record(JSON.stringify({ kind, ...details, timestamp: new Date().toISOString() }));
}

/**
 * The update this daemon is carrying out. Every request for its version joins it and hears its outcome, so a page
 * that asked second learns of a refusal as soon as the page that asked first.
 */
type UpdateAttempt =
    | {
          readonly kind: "preparing";
          readonly version: string;
          readonly announcements: Set<() => void>;
          readonly settled: Promise<void>;
      }
    | { readonly kind: "handed-over"; readonly version: string };

export class DaemonUpdate implements ComputerUpdate {
    readonly #options: DaemonUpdateOptions;
    #attempt: UpdateAttempt | null = null;

    constructor(options: DaemonUpdateOptions) {
        this.#options = options;
    }

    readonly restartInto = async (version: string, announce: () => void, signal: AbortSignal): Promise<void> => {
        const { entry, lifecycleLog, processes, stop } = this.#options;
        const current = this.#options.version;
        if (!isNewerMortyRelease(version, current)) {
            throw new OperationError("update_not_newer", `This computer already runs Morty ${current}.`);
        }
        const attempt = this.#attempt;
        if (attempt !== null) {
            if (attempt.version !== version) {
                throw new OperationError("update_in_progress", "This computer is already updating Morty.");
            }
            if (attempt.kind === "handed-over") {
                announce();
                return;
            }
            attempt.announcements.add(announce);
            try {
                await waitForSharedOperation(attempt.settled, signal);
            } finally {
                attempt.announcements.delete(announce);
            }
            return;
        }
        const settled = Promise.withResolvers<void>();
        // A refusal nobody else joined still settles the attempt; only its own request reports it.
        settled.promise.catch(() => undefined);
        const preparing = {
            kind: "preparing",
            version,
            announcements: new Set([announce]),
            settled: settled.promise,
        } as const;
        this.#attempt = preparing;
        let updater: ChildProcess | undefined;
        try {
            refuseWhileWorking(processes);
            recordUpdate(lifecycleLog, "daemon_update_requested", { from: current, to: version });
            await downloadRelease(version, signal);
            updater = await spawnUpdater(entry, version);
            // Nothing awaits between this check and stop(), so no Agent work can begin before the Computer stops.
            refuseWhileWorking(processes);
            for (const announcement of preparing.announcements) {
                announcement();
            }
            this.#attempt = { kind: "handed-over", version };
            settled.resolve();
            recordUpdate(lifecycleLog, "daemon_update_handed_over", { from: current, to: version });
            stop();
        } catch (error) {
            updater?.kill();
            this.#attempt = null;
            settled.reject(error);
            recordUpdate(lifecycleLog, "daemon_update_refused", {
                from: current,
                to: version,
                code: error instanceof OperationError ? error.code : "update_failed",
            });
            throw error;
        }
    };
}

function refuseWhileWorking(processes: AgentProcessPool): void {
    if (processes.hasWork()) {
        throw new OperationError("computer_busy", "Morty updates when no task is running on this computer.");
    }
}

async function downloadRelease(version: string, signal: AbortSignal): Promise<void> {
    const npx = await findNpx();
    try {
        await runBoundedProcess({
            command: npx,
            arguments: ["--yes", `${MORTY_PACKAGE_NAME}@${version}`, "--help"],
            cwd: homedir(),
            environment: process.env,
            signal,
            timeoutMilliseconds: RELEASE_DOWNLOAD_TIMEOUT_MILLISECONDS,
        });
    } catch (cause) {
        signal.throwIfAborted();
        throw new OperationError("update_download_failed", `Morty ${version} could not be downloaded.`, { cause });
    }
}

// The updater must outlive this daemon, so it runs detached rather than among the Agent process trees stop() ends.
async function spawnUpdater(entry: string, version: string): Promise<ChildProcess> {
    const updater = spawn(process.execPath, [entry, "__update", version], {
        detached: true,
        windowsHide: true,
        env: process.env,
        stdio: "ignore",
    });
    try {
        await once(updater, "spawn");
    } catch (cause) {
        throw new OperationError("update_failed", "Morty could not start its updater.", { cause });
    }
    updater.unref();
    return updater;
}
