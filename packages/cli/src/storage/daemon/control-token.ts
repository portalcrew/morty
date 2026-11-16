import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    createInstallationFile,
    type InstallationDirectory,
} from "../../engine/storage/installation/installation-files.ts";
import { isNodeError } from "../../engine/util/node-error.ts";

function controlTokenPath(stateDirectory: InstallationDirectory): string {
    return join(stateDirectory, "daemon.token");
}

export async function readOrCreateControlToken(stateDirectory: InstallationDirectory): Promise<string> {
    const path = controlTokenPath(stateDirectory);
    try {
        return (await readFile(path, "utf8")).trim();
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
    }
    const token = randomBytes(32).toString("base64url");
    try {
        await createInstallationFile(path, `${token}\n`);
        return token;
    } catch (cause) {
        if (!isNodeError(cause, "EEXIST")) {
            throw cause;
        }
        return (await readFile(path, "utf8")).trim();
    }
}
