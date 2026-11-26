import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { LocalPathError } from "../filesystem/path-error.ts";
import { claudeDesktopExecutablePaths, installedDirectories } from "./claude-desktop.ts";
import type { PlatformSupport } from "./contracts.ts";
import { validateWindowsPipe } from "./windows-pipe.ts";

const execute = promisify(execFile);

function environmentValue(environment: Readonly<NodeJS.ProcessEnv>, name: string): string | undefined {
    return Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

function desktopClaudeExecutablePaths(environment: Readonly<NodeJS.ProcessEnv>): readonly string[] {
    const roots: string[] = [];
    const localAppData = environmentValue(environment, "LOCALAPPDATA");
    if (localAppData !== undefined && isAbsolute(localAppData)) {
        const dataDirectory = join(localAppData, "Claude-Data");
        for (const installation of installedDirectories(dataDirectory)) {
            if (installation.startsWith("claude_")) {
                roots.push(join(dataDirectory, installation, "claude-code"));
            }
        }
    }
    const appData = environmentValue(environment, "APPDATA");
    if (appData !== undefined && isAbsolute(appData)) {
        roots.push(join(appData, "Claude", "claude-code"));
    }
    return claudeDesktopExecutablePaths(roots, [["claude.exe"]]);
}

// The path is data in the environment, never interpolated into PowerShell source.
const windowsPermissions = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$item = Get-Item -LiteralPath $env:MORTY_PERMISSION_PATH -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe path' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = $item.GetAccessControl()
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
if ($owner -ne $sid -and -not ($owner.Value -eq 'S-1-5-32-544' -and ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) { throw 'Path is not user-owned' }
if ($env:MORTY_PERMISSION_PRIVATE -eq '1') {
    if ($item.PSIsContainer) {
        $private = New-Object Security.AccessControl.DirectorySecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $private = New-Object Security.AccessControl.FileSecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
    }
    $private.SetOwner($sid)
    $private.SetAccessRuleProtection($true, $false)
    $private.AddAccessRule($rule)
    $item.SetAccessControl($private)
}
`;

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED holds for this thread until PowerShell exits when the Runtime closes its input.
const keepSystemAwake = `
$power = Add-Type -Namespace Morty -Name Power -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
if ($power::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }
[Console]::In.ReadToEnd() | Out-Null
`;

// Keep ACL validation bounded in case Windows filesystem operations stall.
const windowsPermissionsTimeoutMs = 30_000;

async function validatePathPermissions(
    path: string,
    _directory: boolean,
    privateAccess: boolean,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const systemRoot = environmentValue(process.env, "SystemRoot");
    if (systemRoot === undefined) {
        throw new LocalPathError("Windows system directory is unavailable");
    }
    try {
        await execute(
            join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(windowsPermissions, "utf16le").toString("base64"),
            ],
            {
                env: {
                    ...process.env,
                    MORTY_PERMISSION_PATH: path,
                    MORTY_PERMISSION_PRIVATE: privateAccess ? "1" : "0",
                },
                windowsHide: true,
                signal: AbortSignal.any([signal, AbortSignal.timeout(windowsPermissionsTimeoutMs)]),
                timeout: windowsPermissionsTimeoutMs,
                maxBuffer: 16384,
            },
        );
    } catch (cause) {
        signal.throwIfAborted();
        throw new LocalPathError("The local path permissions could not be secured", { cause });
    }
}

export const windowsPlatform: PlatformSupport = {
    controlSocketPath: (installationHash) => `\\\\.\\pipe\\morty-${installationHash}`,
    prepareControlSocket: async () => {},
    secureControlSocket: validateWindowsPipe,
    validateControlPeer: validateWindowsPipe,
    removeControlSocket: async () => {},
    validatePathPermissions,
    claudeCodeExecutablePaths: (environment) => {
        const paths: string[] = [];
        const userProfile = environmentValue(environment, "USERPROFILE");
        if (userProfile !== undefined && isAbsolute(userProfile)) {
            paths.push(join(userProfile, ".local", "bin", "claude.exe"));
        }
        const localAppData = environmentValue(environment, "LOCALAPPDATA");
        if (localAppData !== undefined && isAbsolute(localAppData)) {
            paths.push(join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"));
        }
        paths.push(...desktopClaudeExecutablePaths(environment));
        return paths;
    },
    idleSleepInhibitors: (environment) => {
        const systemRoot = environmentValue(environment, "SystemRoot");
        return systemRoot === undefined
            ? []
            : [
                  {
                      command: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
                      arguments: [
                          "-NoLogo",
                          "-NoProfile",
                          "-NonInteractive",
                          "-EncodedCommand",
                          Buffer.from(keepSystemAwake, "utf16le").toString("base64"),
                      ],
                  },
              ];
    },
};
