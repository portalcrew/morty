import { access, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { foldPathCase, isWithinDirectory } from "../engine/storage/files/local-files.ts";
import { isNodeError } from "../engine/util/node-error.ts";
import { readStateDirectory } from "./state-directory.ts";

/** The configured state directory holds another root's installation data, so Morty must not create a root there. */
export class StateRootError extends Error {
    readonly code = "state_root_is_installation_data";
    readonly owningRoot: string;

    constructor(stateDirectory: string, owningRoot: string) {
        super(
            `MORTY_STATE_DIRECTORY (${stateDirectory}) is Morty installation data, not a state root. ` +
                `Use the state root that owns it: MORTY_STATE_DIRECTORY=${owningRoot}`,
        );
        this.name = "StateRootError";
        this.owningRoot = owningRoot;
    }
}

async function owningRoot(directory: string): Promise<string | null> {
    if (basename(directory) === "computer") {
        // Recognize actual setup or daemon state instead of maintaining a separate ownership marker.
        for (const path of [
            join(dirname(directory), "config.json"),
            join(directory, "pairing.json"),
            join(directory, "daemon.lock.sqlite"),
        ]) {
            try {
                await access(path);
                return dirname(directory);
            } catch (error) {
                if (!isNodeError(error, "ENOENT")) {
                    throw error;
                }
            }
        }
    }
    return null;
}

export async function validateStateRoot(environment: Readonly<NodeJS.ProcessEnv>): Promise<void> {
    const directory = readStateDirectory(environment);
    const root = await owningRoot(directory);
    if (root !== null) {
        throw new StateRootError(directory, root);
    }
}

/**
 * Whether a canonical path is Morty's own state: anything in the Runtime's installation directory, and the setup state
 * that a standard installation directory keeps beside it. Both hold the Computer's credentials and keys.
 */
export async function isMortyStatePath(path: string, installationDirectory: string): Promise<boolean> {
    if (await isWithinDirectory(path, installationDirectory)) {
        return true;
    }
    const installation = await realpath(installationDirectory).catch(() => resolve(installationDirectory));
    if (basename(installation) !== "computer" || foldPathCase(dirname(path)) !== foldPathCase(dirname(installation))) {
        return false;
    }
    const name = foldPathCase(basename(path));
    return name === "config.json" || name.startsWith(".config-");
}
