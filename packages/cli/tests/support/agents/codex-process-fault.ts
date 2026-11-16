import { writeFile } from "node:fs/promises";
import { executableLaunch } from "../../../src/engine/util/process/executable.ts";
import type { CodexFixture } from "./codex.ts";

export async function writeCodexFaultLauncher(codex: CodexFixture, path: string, faultPath: string): Promise<void> {
    const launch = executableLaunch(codex.executable, []);
    await writeFile(
        path,
        `#!${process.execPath}
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, watch } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
const child = spawn(${JSON.stringify(launch.command)}, [...${JSON.stringify(launch.arguments)}, ...process.argv.slice(2)], {
    stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...${JSON.stringify(codex.environment)} },
});
let pending;
const faultPath = ${JSON.stringify(faultPath)};
watch(dirname(faultPath), () => {
    if (existsSync(faultPath) && readFileSync(faultPath, "utf8") === "idle-exit") {
        unlinkSync(faultPath);
        child.kill("SIGKILL");
    }
});
createInterface({input: process.stdin}).on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "turn/start" && existsSync(faultPath)) {
        const fault = readFileSync(faultPath, "utf8");
        unlinkSync(faultPath);
        if (fault === "before-ack") { child.kill("SIGKILL"); return; }
        pending = {id: message.id, fault};
    }
    if (!child.stdin.destroyed) child.stdin.write(line + "\\n");
});
createInterface({input: child.stdout}).on("line", line => {
    process.stdout.write(line + "\\n");
    if (pending === undefined) return;
    const message = JSON.parse(line);
    if (message.id !== pending.id) return;
    const fault = pending.fault;
    pending = undefined;
    if (fault === "invalid-frame") process.stdout.write("invalid JSON frame\\n");
    child.kill("SIGKILL");
});
child.stdin.on("error", () => {});
child.once("error", () => process.exit(1));
child.once("exit", code => process.exit(code ?? 1));
`,
        { mode: 0o700 },
    );
}
