import { existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { executableLaunch } from "../../../src/engine/util/process/executable.ts";

export async function writeObservedAgentLauncher(
    executable: string,
    launcher: string,
    processes: string,
): Promise<void> {
    const launch = executableLaunch(executable, []);
    await writeFile(
        launcher,
        `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const child = spawn(${JSON.stringify(launch.command)}, [...${JSON.stringify(launch.arguments)}, ...process.argv.slice(2)], {
    stdio: "inherit", env: process.env,
});
const marker = process.argv.includes("--version") ? null : join(${JSON.stringify(processes)}, String(process.pid) + ".process");
if (marker !== null) writeFileSync(marker, String(child.pid));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.once("error", () => process.exit(1));
child.once("exit", code => {
    if (marker !== null) unlinkSync(marker);
    process.exit(code ?? 0);
});
`,
        { mode: 0o700 },
    );
}

export async function waitForAgentFile(path: string, present: boolean, signal: AbortSignal): Promise<void> {
    if (existsSync(path) === present) {
        return;
    }
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const watcher = watch(dirname(path), () => {
            if (existsSync(path) === present) {
                finish();
                resolve();
            }
        });
        const abort = (): void => {
            finish();
            reject(new Error(`Agent file did not become ${present ? "present" : "absent"}: ${path}`));
        };
        const finish = (): void => {
            watcher.close();
            signal.removeEventListener("abort", abort);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (existsSync(path) === present) {
            finish();
            resolve();
        }
    });
}
