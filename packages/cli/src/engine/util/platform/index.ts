import type { PlatformSupport } from "./contracts.ts";
import { linuxPlatform } from "./linux.ts";
import { macosPlatform } from "./macos.ts";
import { posixOperations } from "./posix.ts";
import { windowsPlatform } from "./windows.ts";

// Preserve the existing fallback for other POSIX hosts.
const fallbackPlatform: PlatformSupport = {
    ...posixOperations,
    claudeCodeExecutablePaths: () => [],
    idleSleepInhibitors: () => [],
};
const platforms: ReadonlyMap<NodeJS.Platform, PlatformSupport> = new Map([
    ["linux", linuxPlatform],
    ["darwin", macosPlatform],
    ["win32", windowsPlatform],
]);

export const hostPlatform: PlatformSupport = platforms.get(process.platform) ?? fallbackPlatform;
