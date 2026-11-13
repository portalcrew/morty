import { refreshAgentCatalog } from "../../engine/runtime/catalog/refresh-agent-catalog.ts";
import type { RuntimeConfig } from "../../engine/runtime/config.ts";
import { prepareComputerConnection } from "../../engine/runtime/pairing.ts";
import { ComputerRelayRevokedError } from "../../engine/runtime/relay/computer-revocation.ts";
import { runRuntime } from "../../engine/runtime/run.ts";
import { AgentProcessPool } from "../../engine/session/process/agent-process-pool.ts";
import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { BoundedLineLog } from "../../engine/storage/logs/bounded-log.ts";
import { DAEMON_LIFECYCLE_LOG_FILENAME, logDirectory } from "../../engine/storage/logs/log-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";
import { systemTimer } from "../../engine/util/timer.ts";
import { acquireDaemonLock } from "../../storage/daemon/daemon-lock.ts";
import { sendLocalRequest } from "../control/local-client.ts";
import { serveLocalControl } from "../control/local-server.ts";
import { openMortyInstallation } from "../pairing/pair-local-computer.ts";
import { surviveUnhandledRejections, type UnhandledRejectionGuard } from "./unhandled-rejection.ts";

class DaemonRuntimeError extends Error {
    readonly code = "worker_runtime_failed";
    constructor(pairingGeneration: string, cause: unknown) {
        super(`Computer pairing ${pairingGeneration} failed`, { cause });
    }
}

export async function reloadDaemon(stateDirectory: InstallationDirectory, signal: AbortSignal): Promise<void> {
    try {
        const response = await sendLocalRequest(stateDirectory, { kind: "reload" }, signal);
        if (
            typeof response !== "object" ||
            response === null ||
            !("kind" in response) ||
            response.kind !== "reloaded"
        ) {
            throw new Error("Saved configuration could not be applied to the running daemon");
        }
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
            throw cause;
        }
    }
}

/** Releases idle Agent processes of a running daemon; succeeds when no daemon is running. */
export async function releaseIdleAgentProcesses(
    stateDirectory: InstallationDirectory,
    signal: AbortSignal,
): Promise<void> {
    try {
        const response = await sendLocalRequest(stateDirectory, { kind: "release" }, signal);
        if (typeof response === "object" && response !== null && "kind" in response && response.kind === "released") {
            return;
        }
        throw new Error(
            "The running daemon cannot release Agent sessions. Restart the daemon with the current Morty CLI first.",
        );
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
            throw cause;
        }
    }
}

export async function runDaemon(version: string, signal: AbortSignal): Promise<void> {
    // Install before any await: an unhandled rejection during startup itself
    // must not kill the daemon before the guard exists.
    const rejectionGuard = surviveUnhandledRejections();
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    try {
        await runDaemonRuntime(version, combined, shutdown, rejectionGuard);
    } catch (cause) {
        const control = await openMortyInstallation(AbortSignal.timeout(5_000), process.env);
        new BoundedLineLog(logDirectory(control.stateDirectory), DAEMON_LIFECYCLE_LOG_FILENAME, 512 * 1024).record(
            JSON.stringify({
                kind: "daemon_failed",
                message: cause instanceof Error ? cause.message : "Daemon failed",
            }),
        );
        throw cause;
    } finally {
        shutdown.abort();
        rejectionGuard.release();
    }
}

async function runDaemonRuntime(
    version: string,
    combined: AbortSignal,
    shutdown: AbortController,
    rejectionGuard: UnhandledRejectionGuard,
): Promise<void> {
    const control = await openMortyInstallation(combined, process.env);
    const releaseDaemon = await acquireDaemonLock(control.stateDirectory);
    if (releaseDaemon === null) {
        return;
    }
    const lifecycleLog = new BoundedLineLog(
        logDirectory(control.stateDirectory),
        DAEMON_LIFECYCLE_LOG_FILENAME,
        512 * 1024,
    );
    lifecycleLog.record(
        JSON.stringify({ kind: "daemon_started", pid: process.pid, version, timestamp: new Date().toISOString() }),
    );
    try {
        const installation = control;
        rejectionGuard.bindStateDirectory(control.stateDirectory);
        let active:
            | {
                  readonly pairingGeneration: string;
                  readonly config: RuntimeConfig;
                  readonly processes: AgentProcessPool;
                  readonly controller: AbortController;
                  readonly completion: Promise<void>;
              }
            | undefined;
        const fail = (pairingGeneration: string, cause: unknown): void => {
            console.error(`Computer pairing ${pairingGeneration} failed; stopping the daemon`, cause);
            shutdown.abort(new DaemonRuntimeError(pairingGeneration, cause));
        };
        const reconcile = async (): Promise<void> => {
            const connection = await installation.currentConnection(combined);
            if (active !== undefined) {
                if (connection?.activation === "active" && connection.pairingGeneration === active.pairingGeneration) {
                    return;
                }
                active.controller.abort();
                await active.completion;
                active = undefined;
            }
            if (connection?.activation === "active") {
                try {
                    const config = await prepareComputerConnection(installation, connection, combined, process.env);
                    const controller = new AbortController();
                    const processes = new AgentProcessPool();
                    const initialized = Promise.withResolvers<void>();
                    const completion = runRuntime(config, AbortSignal.any([combined, controller.signal]), systemTimer, {
                        processes,
                        onInitialized: initialized.resolve,
                    }).then(
                        () => {
                            if (!combined.aborted && !controller.signal.aborted) {
                                fail(connection.pairingGeneration, new Error("The Computer stopped unexpectedly"));
                            }
                        },
                        async (cause: unknown) => {
                            if (combined.aborted || controller.signal.aborted) {
                                return;
                            }
                            if (!(cause instanceof ComputerRelayRevokedError)) {
                                fail(connection.pairingGeneration, cause);
                                return;
                            }
                            // A revoked Computer never connects again; setup pairs this computer anew, and the daemon
                            // keeps running to serve that pairing.
                            lifecycleLog.record(
                                JSON.stringify({
                                    kind: "computer_revoked",
                                    pairingGeneration: connection.pairingGeneration,
                                    timestamp: new Date().toISOString(),
                                }),
                            );
                            console.error(
                                "Morty disconnected this Computer: its connection key was used somewhere else. Run Morty setup on this computer again to reconnect.",
                            );
                            await installation
                                .setConnectionActivation(connection.pairingGeneration, "stopped", combined)
                                .catch((failure: unknown) => fail(connection.pairingGeneration, failure));
                        },
                    );
                    active = {
                        pairingGeneration: connection.pairingGeneration,
                        config,
                        processes,
                        controller,
                        completion,
                    };
                    // Local encryption and database initialization must finish before
                    // the control endpoint may advertise a healthy daemon. Relay
                    // availability remains independent of local startup readiness.
                    await Promise.race([
                        initialized.promise,
                        completion.then(() => {
                            combined.throwIfAborted();
                            throw new DaemonRuntimeError(
                                connection.pairingGeneration,
                                new Error("The Computer stopped before initialization"),
                            );
                        }),
                    ]);
                } catch (cause) {
                    combined.throwIfAborted();
                    fail(connection.pairingGeneration, cause);
                    throw cause;
                }
            }
        };
        let reload: Promise<void> = Promise.resolve();
        const handle = async (request: unknown) => {
            if (typeof request === "object" && request !== null && "kind" in request) {
                if (request.kind === "status") {
                    return { kind: "status", protocolVersion: 3, daemon: { pid: process.pid, version } };
                }
                if (request.kind === "stop") {
                    return { kind: "stopped" };
                }
            }
            if (typeof request === "object" && request !== null && "kind" in request && request.kind === "release") {
                // Agents' own clients can continue the conversations that idle processes held.
                await active?.processes.retireIdleProcesses();
                return { kind: "released" };
            }
            if (typeof request !== "object" || request === null || !("kind" in request) || request.kind !== "reload") {
                return { kind: "error", code: "unsupported_operation", message: "Unknown local control operation" };
            }
            // A reload, such as `morty start` after the user installs or signs in to an Agent, also re-reads the
            // Agent inventory of Computers that were already running; Computers it starts read it themselves.
            const pending = reload.then(async () => {
                const previous = active;
                await reconcile();
                if (active !== undefined && previous === active) {
                    try {
                        await refreshAgentCatalog(
                            active.config,
                            AbortSignal.any([combined, AbortSignal.timeout(90_000)]),
                        );
                    } catch (cause) {
                        combined.throwIfAborted();
                        console.error("Could not refresh the Agent catalog", cause);
                    }
                }
            });
            reload = pending.catch(() => undefined);
            await pending;
            return { kind: "reloaded" };
        };
        try {
            await reconcile();
            lifecycleLog.record(
                JSON.stringify({
                    kind: "daemon_ready",
                    pid: process.pid,
                    version,
                    timestamp: new Date().toISOString(),
                }),
            );
            await serveLocalControl(
                control.stateDirectory,
                combined,
                handle,
                () => undefined,
                (response) => {
                    if (
                        typeof response === "object" &&
                        response !== null &&
                        "kind" in response &&
                        response.kind === "stopped"
                    ) {
                        shutdown.abort();
                    }
                },
            );
            if (shutdown.signal.reason instanceof DaemonRuntimeError) {
                throw shutdown.signal.reason;
            }
        } finally {
            shutdown.abort();
            await reload;
            await active?.completion;
        }
    } finally {
        await releaseDaemon();
    }
}
