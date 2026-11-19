import type { SessionMetadata } from "@portalcrew/morty-client/protocol";
import type { RecentCwdPreference } from "@/services/chat/last-cwd-preference";

export type SessionDirectory = Pick<SessionMetadata, "directory" | "directoryLabel" | "updatedAt">;

export type DirectoryAvailability = "available" | "missing";

export type RecentDirectory = RecentCwdPreference & { readonly source: "session" | "chosen" };

const SESSION_DIRECTORY_LIMIT = 10;

export function sessionDirectories(sessions: readonly SessionDirectory[]): readonly RecentCwdPreference[] {
    const latest = new Map<string, SessionDirectory>();
    for (const session of sessions) {
        const known = latest.get(session.directory);
        if (known === undefined || Date.parse(session.updatedAt) > Date.parse(known.updatedAt)) {
            latest.set(session.directory, session);
        }
    }
    return [...latest.values()]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, SESSION_DIRECTORY_LIMIT)
        .map(({ directory, directoryLabel }) => ({ directory, directoryLabel }));
}

/** A Session keeps its recorded directory after that directory is moved or deleted, so only confirmed ones are offered. */
export function recentDirectories(
    sessions: readonly SessionDirectory[],
    chosen: readonly RecentCwdPreference[],
    availability: ReadonlyMap<string, DirectoryAvailability>,
): readonly RecentDirectory[] {
    const used = sessionDirectories(sessions).filter(
        (directory) => availability.get(directory.directory) === "available",
    );
    return [
        ...used.map((directory) => ({ ...directory, source: "session" as const })),
        ...chosen
            .filter((directory) => !used.some((session) => session.directory === directory.directory))
            .map((directory) => ({ ...directory, source: "chosen" as const })),
    ];
}
