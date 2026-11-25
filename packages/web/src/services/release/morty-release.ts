const releaseVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function releaseParts(version: unknown): readonly number[] | null {
    return typeof version === "string" && version.length <= 32 && releaseVersionPattern.test(version)
        ? version.split(".").map(Number)
        : null;
}

/**
 * The Morty CLI released with this page, which deployment activates only once it is npm's latest release. Builds
 * outside a release have none, so they never ask for an update.
 */
const configuredRelease: unknown = import.meta.env["VITE_MORTY_CLI_VERSION"];
export const mortyReleaseVersion: string | null =
    typeof configuredRelease === "string" && releaseParts(configuredRelease) !== null ? configuredRelease : null;

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
 * For the Agent on the outdated computer. Restarting Morty ends the Agent's own processes, so a restart it runs in the
 * foreground would stop the old daemon and die before starting the new one; detached and delayed, the restart outlives
 * the Agent's reply.
 */
export const mortyUpdatePrompt = `Update Morty on this computer to the latest release.
Restarting Morty ends this conversation, so start the update as a detached background process that waits 15 seconds, then reply before it begins.
On macOS or Linux, run:
nohup sh -c 'sleep 15; npx --yes @portalcrew/morty@latest restart' > /dev/null 2>&1 &
On Windows, start the same steps as a hidden background process with PowerShell's Start-Process.`;
