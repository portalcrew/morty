import { isAbsolute, join } from "node:path";
import { claudeDesktopExecutablePaths } from "./claude-desktop.ts";
import type { PlatformSupport } from "./contracts.ts";
import { posixOperations } from "./posix.ts";

export const macosPlatform: PlatformSupport = {
    ...posixOperations,
    claudeCodeExecutablePaths: (environment) => {
        const paths = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
        const homeDirectory = environment["HOME"];
        if (homeDirectory !== undefined && isAbsolute(homeDirectory)) {
            paths.unshift(join(homeDirectory, ".local", "bin", "claude"));
            paths.push(
                ...claudeDesktopExecutablePaths(
                    [join(homeDirectory, "Library", "Application Support", "Claude", "claude-code")],
                    [["claude.app", "Contents", "MacOS", "claude"], ["claude"]],
                ),
            );
        }
        return paths;
    },
    // With a utility to run, caffeinate execs it in the launched process and asserts from a forked child, so the
    // Runtime would not see the assertion end. Watching the Runtime keeps the assertion in the process it launched.
    idleSleepInhibitors: () => [{ command: "/usr/bin/caffeinate", arguments: ["-i", "-w", String(process.pid)] }],
};
