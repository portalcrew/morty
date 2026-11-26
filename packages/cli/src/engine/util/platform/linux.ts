import { isAbsolute, join } from "node:path";
import type { PlatformSupport } from "./contracts.ts";
import { posixOperations } from "./posix.ts";

const IDLE_SLEEP_REASON = "An Agent is working on a Morty task";

export const linuxPlatform: PlatformSupport = {
    ...posixOperations,
    claudeCodeExecutablePaths: (environment) => {
        const homeDirectory = environment["HOME"];
        return homeDirectory !== undefined && isAbsolute(homeDirectory)
            ? [join(homeDirectory, ".local", "bin", "claude")]
            : [];
    },
    // GNOME suspends an idle session itself and honors only its session inhibitors, not logind's idle lock.
    idleSleepInhibitors: () => [
        {
            command: "gnome-session-inhibit",
            arguments: ["--inhibit", "suspend", "--app-id", "morty", "--reason", IDLE_SLEEP_REASON, "cat"],
        },
        {
            command: "systemd-inhibit",
            arguments: ["--what=idle", "--mode=block", "--who=Morty", `--why=${IDLE_SLEEP_REASON}`, "cat"],
        },
    ],
};
