import { findExecutableOnPath, resolveExecutablePath } from "../../../src/engine/util/process/executable.ts";

export async function resolveTestExecutable(name: string, overrideVariable: string): Promise<string> {
    const configured = process.env[overrideVariable];
    const executable =
        configured === undefined
            ? await findExecutableOnPath(name, process.env)
            : await resolveExecutablePath(configured);
    if (executable === null) {
        throw new Error(`Real ${name} is required; set ${overrideVariable} or put ${name} on PATH`);
    }
    return executable.path;
}

/** A script that runs under the Node binary executing the tests. */
export function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}
