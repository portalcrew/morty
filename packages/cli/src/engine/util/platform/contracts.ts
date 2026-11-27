import type { ProcessLaunch } from "../process/platform/contracts.ts";

export interface PlatformSupport {
    readonly controlSocketPath: (installationHash: string) => string;
    readonly prepareControlSocket: (path: string) => Promise<void>;
    readonly secureControlSocket: (path: string, signal: AbortSignal) => Promise<void>;
    readonly validateControlPeer: (path: string, signal: AbortSignal) => Promise<void>;
    readonly removeControlSocket: (path: string) => Promise<void>;
    readonly validatePathPermissions: (
        path: string,
        directory: boolean,
        privateAccess: boolean,
        signal: AbortSignal,
    ) => Promise<void>;
    readonly claudeCodeExecutablePaths: (environment: Readonly<NodeJS.ProcessEnv>) => readonly string[];
    /**
     * Commands that each keep the computer from sleeping while idle, in order of preference. Each holds until it is
     * stopped, and also stops when the Runtime exits without releasing it.
     */
    readonly idleSleepInhibitors: (environment: Readonly<NodeJS.ProcessEnv>) => readonly ProcessLaunch[];
}
