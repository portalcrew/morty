import { isAbsolute, join } from "node:path";
import type { PlatformSupport } from "./contracts.ts";
import { posixOperations } from "./posix.ts";

export const linuxPlatform: PlatformSupport = {
    ...posixOperations,
    claudeCodeExecutablePaths: (environment) => {
        const homeDirectory = environment["HOME"];
        return homeDirectory !== undefined && isAbsolute(homeDirectory)
            ? [join(homeDirectory, ".local", "bin", "claude")]
            : [];
    },
    // Released GNOME turns a suspend inhibitor into a logind lock that, from systemd 257, also blocks the person's own
    // suspend, and KDE reads logind's idle lock as "keep the screen on" without stopping idle suspend. Linux keeps its
    // own sleep behavior until a lock is verified on those desktops.
    idleSleepInhibitors: () => [],
};
