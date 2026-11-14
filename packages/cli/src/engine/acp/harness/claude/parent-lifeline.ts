import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// The SDK's stdin may close gracefully while Claude is still finishing. A separate pipe
// distinguishes that from the owning daemon dying, including an uncatchable SIGKILL.
const supervisor = `
const { spawn, spawnSync } = require("node:child_process");
const { Socket } = require("node:net");
const [command, ...args] = process.argv.slice(1);
const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
const lifeline = new Socket({ fd: 3, readable: true, writable: false });
let exited = false;
function terminate() {
    if (exited || child.pid === undefined) return;
    if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 5000, windowsHide: true, stdio: "ignore" });
    } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
    }
}
lifeline.on("end", terminate).on("error", terminate).resume();
process.on("SIGTERM", terminate).on("SIGINT", terminate);
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("error", (error) => { process.stderr.write(error.message); process.exitCode = 1; lifeline.destroy(); process.stdin.destroy(); });
child.once("close", (code) => { exited = true; process.exitCode = code ?? 1; lifeline.destroy(); process.stdin.destroy(); });
`;

export function spawnClaudeWithParentLifeline(options: SpawnOptions): SpawnedProcess {
    options.signal.throwIfAborted();
    const child = spawn(process.execPath, ["-e", supervisor, "--", options.command, ...options.args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    const lifeline = child.stdio[3];
    if (!(lifeline instanceof Duplex)) {
        child.kill("SIGKILL");
        throw new Error("The Claude process supervisor has no parent lifeline");
    }
    let termination: "running" | "requested" = "running";
    const stop = (): boolean => {
        termination = "requested";
        lifeline.end();
        return true;
    };
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) {
        stop();
    }
    child.once("close", () => options.signal.removeEventListener("abort", stop));
    child.stderr.pipe(process.stderr, { end: false });
    return {
        stdin: child.stdin,
        stdout: child.stdout,
        get killed() {
            return termination === "requested";
        },
        get exitCode() {
            return child.exitCode;
        },
        get signalCode() {
            return child.signalCode;
        },
        kill: stop,
        on: child.on.bind(child),
        once: child.once.bind(child),
        off: child.off.bind(child),
    };
}
