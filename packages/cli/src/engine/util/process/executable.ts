import {
    type ChildProcess,
    type ChildProcessWithoutNullStreams,
    type SpawnOptions,
    type SpawnOptionsWithoutStdio,
    spawn,
} from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ProcessLaunch, ProcessTreeIdentity, SpawnedProcess } from "./platform/contracts.ts";
import { hostProcessPlatform as hostPlatform } from "./platform/index.ts";

import { ProcessExecutionError } from "./process-error.ts";

export type { ProcessTreeIdentity } from "./platform/contracts.ts";
export { ProcessExecutionError } from "./process-error.ts";

const DEFAULT_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PROCESS_GRACEFUL_STOP_TIMEOUT_MILLISECONDS = 1_000;
const PROCESS_FORCED_STOP_TIMEOUT_MILLISECONDS = 5_000;
const PROCESS_EXIT_CHECK_ATTEMPTS = 16;
const GRACEFUL_STOP_SIGNAL = 15;
const FORCED_STOP_SIGNAL = 9;

export class ExecutableIdentity {
    readonly changedAtMilliseconds: number;
    readonly device: number;
    readonly inode: number;
    readonly realPath: string;
    readonly requestedPath: string;
    readonly size: number;

    constructor(
        requestedPath: string,
        realPath_: string,
        device: number,
        inode: number,
        size: number,
        changedAtMilliseconds: number,
    ) {
        this.changedAtMilliseconds = changedAtMilliseconds;
        this.device = device;
        this.inode = inode;
        this.realPath = realPath_;
        this.requestedPath = requestedPath;
        this.size = size;
    }

    readonly matches = (candidate: ExecutableIdentity): boolean =>
        this.requestedPath === candidate.requestedPath &&
        this.realPath === candidate.realPath &&
        this.device === candidate.device &&
        this.inode === candidate.inode &&
        this.size === candidate.size &&
        this.changedAtMilliseconds === candidate.changedAtMilliseconds;
}

export class ResolvedExecutable {
    readonly identity: ExecutableIdentity;
    readonly path: string;

    constructor(identity: ExecutableIdentity) {
        this.identity = identity;
        this.path = identity.realPath;
    }
}

export class ProcessResult {
    readonly stderr: string;
    readonly stdout: string;

    constructor(stdout: string, stderr: string) {
        this.stderr = stderr;
        this.stdout = stdout;
    }
}

export interface RunProcessOptions {
    readonly arguments: readonly string[];
    readonly command: string;
    readonly cwd: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly outputLimitBytes?: number;
    readonly signal: AbortSignal;
    readonly timeoutMilliseconds: number;
}

export async function resolveExecutablePath(requestedPath: string): Promise<ResolvedExecutable | null> {
    const absoluteRequestedPath = resolve(requestedPath);
    try {
        const resolvedPath = await hostPlatform.resolveExecutableTarget(absoluteRequestedPath);
        const metadata = await stat(resolvedPath);
        if (!metadata.isFile()) {
            return null;
        }
        return new ResolvedExecutable(
            new ExecutableIdentity(
                absoluteRequestedPath,
                resolvedPath,
                metadata.dev,
                metadata.ino,
                metadata.size,
                metadata.ctimeMs,
            ),
        );
    } catch {
        return null;
    }
}

export async function findExecutableOnPath(
    executableName: string,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<ResolvedExecutable | null> {
    const encodedPath = hostPlatform.environmentValue(environment, "PATH") ?? "";
    const separator = hostPlatform.pathDelimiter;
    const extensions = hostPlatform.executableExtensions(executableName, environment);
    for (const entry of encodedPath.split(separator)) {
        if (entry.length === 0) {
            continue;
        }
        for (const extension of extensions) {
            const requestedPath = resolve(join(entry, `${executableName}${extension}`));
            const executable = await resolveExecutablePath(requestedPath);
            if (executable !== null) {
                return executable;
            }
        }
    }
    return null;
}

export async function revalidateExecutable(identity: ExecutableIdentity): Promise<boolean> {
    const current = await resolveExecutablePath(identity.requestedPath);
    return current !== null && identity.matches(current.identity);
}

function appendBounded(chunks: Buffer[], chunk: Buffer, currentBytes: number, limitBytes: number): number {
    const nextBytes = currentBytes + chunk.byteLength;
    if (nextBytes > limitBytes) {
        throw new ProcessExecutionError("process_output_limit", "The executable produced too much output");
    }
    chunks.push(chunk);
    return nextBytes;
}

// Process trees are identified from each child's own lifetime, never from a process ID alone.
const lifetimes = new WeakMap<ChildProcess, SpawnedProcess>();

export function spawnProcess(
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio & { readonly stdio: "pipe" },
): ChildProcessWithoutNullStreams;
export function spawnProcess(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const spawnedAt = Date.now();
    const child = spawn(command, [...args], options);
    const processId = child.pid;
    if (processId !== undefined) {
        lifetimes.set(child, { state: "running", processId, spawnedAt });
        child.once("exit", () => {
            lifetimes.set(child, { state: "exited", processId, spawnedAt, exitedAt: Date.now() });
        });
    }
    return child;
}

function spawnedProcess(child: ChildProcess): SpawnedProcess {
    const lifetime = lifetimes.get(child);
    if (lifetime === undefined) {
        throw new Error("Only a child started by spawnProcess has an identifiable process tree");
    }
    return lifetime;
}

function mergeProcessTrees(
    captured: readonly ProcessTreeIdentity[],
    current: readonly ProcessTreeIdentity[],
): readonly ProcessTreeIdentity[] {
    const processes = new Map<number, ProcessTreeIdentity>();
    for (const identity of captured) {
        processes.set(identity.processId, identity);
    }
    for (const identity of current) {
        processes.set(identity.processId, identity);
    }
    return [...processes.values()];
}

export async function captureProcessTree(child: ChildProcess): Promise<readonly ProcessTreeIdentity[]> {
    if (child.pid === undefined) {
        return [];
    }
    return await hostPlatform.captureProcessTree(spawnedProcess(child));
}

async function waitForCapturedProcessesExit(
    processes: readonly ProcessTreeIdentity[],
    rootProcessId: number,
): Promise<boolean> {
    const processIds = processes
        .map((identity) => identity.processId)
        .filter((processId) => processId !== rootProcessId);
    for (let attempt = 0; attempt < PROCESS_EXIT_CHECK_ATTEMPTS; attempt += 1) {
        if (processIds.every((processId) => !hostPlatform.processExists(processId))) {
            return true;
        }
        await hostPlatform.readProcessTable();
    }
    return processIds.every((processId) => !hostPlatform.processExists(processId));
}

export async function stopProcessTree(
    child: ChildProcess,
    capturedProcesses: readonly ProcessTreeIdentity[] = [],
): Promise<void> {
    const childProcessId = child.pid;
    if (childProcessId === undefined) {
        return;
    }
    const childExited = child.exitCode !== null || child.signalCode !== null;
    const processes = mergeProcessTrees(capturedProcesses, await captureProcessTree(child));
    if (childExited && processes.length === 0) {
        return;
    }
    hostPlatform.signalCapturedProcesses(processes, childProcessId, GRACEFUL_STOP_SIGNAL);
    hostPlatform.terminateProcess(child, "SIGTERM");
    const [exitedAfterTermination, descendantsExitedAfterTermination] = await Promise.all([
        waitForProcessExit(child, PROCESS_GRACEFUL_STOP_TIMEOUT_MILLISECONDS),
        waitForCapturedProcessesExit(processes, childProcessId),
    ]);
    if (exitedAfterTermination && descendantsExitedAfterTermination) {
        return;
    }
    hostPlatform.signalCapturedProcesses(processes, childProcessId, FORCED_STOP_SIGNAL);
    hostPlatform.terminateProcess(child, "SIGKILL");
    const [exitedAfterForce, descendantsExitedAfterForce] = await Promise.all([
        waitForProcessExit(child, PROCESS_FORCED_STOP_TIMEOUT_MILLISECONDS),
        waitForCapturedProcessesExit(processes, childProcessId),
    ]);
    if (!exitedAfterForce || !descendantsExitedAfterForce) {
        throw new ProcessExecutionError("process_termination_timeout", "The executable process could not be stopped");
    }
}

function waitForProcessExit(child: ChildProcess, timeoutMilliseconds: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
    }
    return new Promise<boolean>((resolveExit) => {
        let settled = false;
        const finish = (exited: boolean): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            child.removeListener("exit", handleExit);
            resolveExit(exited);
        };
        const handleExit = (): void => finish(true);
        const timeout = setTimeout(() => finish(false), timeoutMilliseconds);
        child.once("exit", handleExit);
        if (child.exitCode !== null || child.signalCode !== null) {
            finish(true);
        }
    });
}

export async function runBoundedProcess(options: RunProcessOptions): Promise<ProcessResult> {
    options.signal.throwIfAborted();
    const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    const launch = executableLaunch(options.command, options.arguments);
    const child = spawnProcess(launch.command, launch.arguments, {
        cwd: options.cwd,
        ...hostPlatform.spawnOptions,
        env: { ...options.environment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let interruptionFailure: ProcessExecutionError | null = null;
    let interruptionCleanupFailure: ProcessExecutionError | null = null;
    let stopping = false;
    const interrupted = Promise.withResolvers<void>();

    const interrupt = (failure: ProcessExecutionError): void => {
        if (stopping) {
            return;
        }
        stopping = true;
        interruptionFailure = failure;
        const stop = async (): Promise<void> => {
            try {
                await stopProcessTree(child);
            } catch (error) {
                interruptionCleanupFailure =
                    error instanceof ProcessExecutionError
                        ? error
                        : new ProcessExecutionError(
                              "process_termination_failed",
                              "The executable process could not be stopped",
                              { cause: error },
                          );
            } finally {
                interrupted.resolve();
            }
        };
        void stop();
    };

    const collectStdout = (chunk: Buffer): void => {
        if (interruptionFailure !== null) {
            return;
        }
        try {
            stdoutBytes = appendBounded(stdout, chunk, stdoutBytes, outputLimitBytes);
        } catch (error) {
            const failure =
                error instanceof ProcessExecutionError
                    ? error
                    : new ProcessExecutionError("process_output_limit", "The executable produced too much output", {
                          cause: error,
                      });
            interrupt(failure);
        }
    };
    const collectStderr = (chunk: Buffer): void => {
        if (interruptionFailure !== null) {
            return;
        }
        try {
            stderrBytes = appendBounded(stderr, chunk, stderrBytes, outputLimitBytes);
        } catch (error) {
            const failure =
                error instanceof ProcessExecutionError
                    ? error
                    : new ProcessExecutionError("process_output_limit", "The executable produced too much output", {
                          cause: error,
                      });
            interrupt(failure);
        }
    };
    child.stdout?.on("data", collectStdout);
    child.stderr?.on("data", collectStderr);

    const timeout = setTimeout(() => {
        interrupt(new ProcessExecutionError("process_timeout", "The executable probe timed out"));
    }, options.timeoutMilliseconds);
    const abort = (): void =>
        interrupt(
            new ProcessExecutionError("process_cancelled", "The executable probe was cancelled", {
                cause: options.signal.reason,
            }),
        );
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) {
        abort();
    }

    try {
        const completion = new Promise<number>((resolveCompletion, rejectCompletion) => {
            child.once("error", rejectCompletion);
            // Failed exits have no result to drain. Preserve their error and
            // release descendants even when they still own the output pipes.
            child.once("exit", (code) => {
                if (code !== 0) {
                    resolveCompletion(code ?? 1);
                }
            });
            // Exit does not mean the pipes have drained. Keep collecting through
            // close, with the same deadline and cancellation covering that wait.
            child.once("close", (code) => resolveCompletion(code ?? 1));
        });
        const exitCode = await Promise.race([completion, interrupted.promise.then(() => -1)]);
        if (interruptionCleanupFailure !== null) {
            throw interruptionCleanupFailure;
        }
        if (interruptionFailure !== null) {
            throw interruptionFailure;
        }
        if (exitCode !== 0) {
            throw new ProcessExecutionError("process_exit_failed", "The executable probe failed");
        }
        return new ProcessResult(Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8"));
    } catch (error) {
        const failure =
            error instanceof ProcessExecutionError
                ? error
                : new ProcessExecutionError("process_spawn_failed", "The executable could not be started", {
                      cause: error,
                  });
        throw new ProcessExecutionError(failure.code, failure.message, {
            cause: error,
            diagnosticDetails: {
                stdoutBytes: stdoutBytes.toString(),
                stderrBytes: stderrBytes.toString(),
                outputLimitBytes: outputLimitBytes.toString(),
                ...(child.exitCode === null ? {} : { exitCode: child.exitCode.toString() }),
                ...(child.signalCode === null ? {} : { signal: child.signalCode }),
            },
        });
    } finally {
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", abort);
        child.stdout?.removeListener("data", collectStdout);
        child.stderr?.removeListener("data", collectStderr);
        if (stopping) {
            await interrupted.promise;
        } else {
            await stopProcessTree(child);
        }
    }
}

export function executableLaunch(command: string, args: readonly string[]): ProcessLaunch {
    return hostPlatform.executableLaunch(command, args);
}

export const platformSpawnOptions = hostPlatform.spawnOptions;
