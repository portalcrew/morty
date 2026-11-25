const releaseVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function releaseParts(version: unknown): readonly number[] | null {
    return typeof version === "string" && version.length <= 32 && releaseVersionPattern.test(version)
        ? version.split(".").map(Number)
        : null;
}

function configuredRelease(value: unknown): string | null {
    return typeof value === "string" && releaseParts(value) !== null ? value : null;
}

/**
 * The Morty CLI released with this page, which deployment activates only once it is npm's latest release. Builds
 * outside a release have none, so they never ask for an update.
 */
export const mortyReleaseVersion = configuredRelease(import.meta.env["VITE_MORTY_CLI_VERSION"]);

/** The release that was latest a week before this page's; a Computer older than it has been out of date that long. */
export const mortyReleaseWeekAgo = configuredRelease(import.meta.env["VITE_MORTY_CLI_VERSION_WEEK_AGO"]);

/** False whenever either side is not a stable release, so an unknown version never asks for an update. */
export function isNewerMortyRelease(candidate: string, current: string): boolean {
    const next = releaseParts(candidate);
    const running = releaseParts(current);
    if (next === null || running === null) {
        return false;
    }
    for (const [index, part] of next.entries()) {
        const difference = part - (running[index] ?? 0);
        if (difference !== 0) {
            return difference > 0;
        }
    }
    return false;
}

/**
 * For the Agent on the outdated computer. `update` restarts Morty from its own detached session after a delay, because
 * restarting Morty ends the Agent's processes, and an Agent's tool may end every process its command started.
 */
export const mortyUpdatePrompt = `Update Morty on this computer. Run this command once:
npx --yes @portalcrew/morty@latest update

If it exits with code 0 and prints "Morty restarts in 15 seconds.", immediately tell me the restart is scheduled and end your turn.

Otherwise, report the command output and end your turn. Use only the command above.`;
