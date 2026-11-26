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
    idleSleepInhibitors: () => [{ command: "/usr/bin/caffeinate", arguments: ["-i", "/bin/cat"] }],
};
