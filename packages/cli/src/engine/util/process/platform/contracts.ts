import type { ChildProcess } from "node:child_process";

export interface ProcessTreeIdentity {
    readonly processGroupId: number;
    readonly processId: number;
}

export interface ProcessTableEntry extends ProcessTreeIdentity {
    readonly parentProcessId: number;
}

/**
 * A child this Computer spawned. Its PID identifies it only while it runs: the operating system may give the
 * PID to an unrelated process once the child has exited.
 */
export type SpawnedProcess =
    | { readonly state: "running"; readonly processId: number; readonly spawnedAt: number }
    | {
          readonly state: "exited";
          readonly processId: number;
          readonly spawnedAt: number;
          readonly exitedAt: number;
      };

export interface ProcessLaunch {
    readonly command: string;
    readonly arguments: readonly string[];
}

export interface ProcessPlatformSupport {
    readonly pathDelimiter: string;
    readonly environmentValue: (environment: Readonly<NodeJS.ProcessEnv>, name: string) => string | undefined;
    readonly executableExtensions: (name: string, environment: Readonly<NodeJS.ProcessEnv>) => readonly string[];
    readonly resolveExecutableTarget: (path: string) => Promise<string>;
    readonly executableLaunch: (command: string, args: readonly string[]) => ProcessLaunch;
    readonly spawnOptions: { readonly detached: boolean; readonly windowsHide: boolean };
    readonly signalCapturedProcesses: (
        processes: readonly ProcessTreeIdentity[],
        rootProcessId: number,
        signal: number,
    ) => void;
    readonly terminateProcess: (child: ChildProcess, signal: NodeJS.Signals) => void;
    readonly readProcessTable: () => Promise<readonly ProcessTableEntry[]>;
    readonly captureProcessTree: (root: SpawnedProcess) => Promise<readonly ProcessTreeIdentity[]>;
    readonly processExists: (processId: number) => boolean;
}
