import type { ProcessPlatformSupport } from "./contracts.ts";
import { linuxProcessPlatform } from "./linux.ts";
import { macosProcessPlatform } from "./macos.ts";
import { posixOperations, posixProcessTreeCapture, processExists, readProcessTableWithPs } from "./posix.ts";
import { windowsProcessPlatform } from "./windows.ts";

// Preserve the existing fallback for other POSIX hosts.
const fallbackPlatform: ProcessPlatformSupport = {
    ...posixOperations,
    readProcessTable: () => readProcessTableWithPs("/usr/bin/ps"),
    captureProcessTree: posixProcessTreeCapture(
        () => [],
        () => readProcessTableWithPs("/usr/bin/ps"),
    ),
    processExists,
};
const platforms: ReadonlyMap<NodeJS.Platform, ProcessPlatformSupport> = new Map([
    ["linux", linuxProcessPlatform],
    ["darwin", macosProcessPlatform],
    ["win32", windowsProcessPlatform],
]);

export const hostProcessPlatform: ProcessPlatformSupport = platforms.get(process.platform) ?? fallbackPlatform;
