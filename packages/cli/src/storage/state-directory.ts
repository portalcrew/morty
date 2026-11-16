import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

class MortyPathError extends Error {
    readonly code = "morty_state_directory_invalid";
}

export function readStateDirectory(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
    const configured = environment["MORTY_STATE_DIRECTORY"]?.trim();
    if (configured) {
        if (!isAbsolute(configured)) {
            throw new MortyPathError("MORTY_STATE_DIRECTORY must be absolute");
        }
        return configured;
    }
    switch (process.platform) {
        case "win32": {
            const local = environment["LOCALAPPDATA"];
            if (!local || !isAbsolute(local)) {
                throw new MortyPathError("LOCALAPPDATA must be absolute");
            }
            return join(local, "Morty", "v3");
        }
        case "darwin":
            return join(homedir(), "Library", "Application Support", "Morty", "v3");
        default: {
            const state = environment["XDG_STATE_HOME"];
            return join(state && isAbsolute(state) ? state : join(homedir(), ".local", "state"), "morty", "v3");
        }
    }
}
