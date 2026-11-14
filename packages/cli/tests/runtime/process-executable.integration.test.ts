import { watch } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBoundedProcess } from "../../src/engine/util/process/executable.ts";
import { executableSource } from "../support/agents/executable.ts";

function waitForMarker(directory: string, marker: string): Promise<void> {
    return new Promise((resolveMarker) => {
        const watcher = watch(directory, (_event, filename) => {
            if (filename !== marker) {
                return;
            }
            watcher.close();
            resolveMarker();
        });
    });
}

describe("bounded local executable processes", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.skipIf(process.platform === "win32")(
        "Given a version probe ignores graceful termination, When its deterministic deadline expires, Then the process tree is forcibly released and timeout stays distinct",
        async () => {
            vi.useFakeTimers({
                now: new Date("2026-09-04T00:00:00.000Z"),
                toFake: ["Date", "clearTimeout", "setTimeout"],
            });
            const directory = await mkdtemp(join(tmpdir(), "morty-probe-timeout-"));
            const executable = join(directory, "probe");
            const markerName = "started";
            const marker = join(directory, markerName);
            const terminationMarker = join(directory, "termination-requested");
            try {
                await writeFile(
                    executable,
                    executableSource(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(terminationMarker)}, "received"));
writeFileSync(${JSON.stringify(marker)}, process.pid.toString());
setInterval(() => undefined, 60_000);
`),
                    { mode: 0o700 },
                );
                await chmod(executable, 0o700);
                const started = waitForMarker(directory, markerName);
                const terminationRequested = waitForMarker(directory, "termination-requested");
                const execution = runBoundedProcess({
                    arguments: ["--version"],
                    command: executable,
                    cwd: directory,
                    environment: { PATH: "/usr/bin:/bin" },
                    signal: new AbortController().signal,
                    timeoutMilliseconds: 3_000,
                });
                const outcome = execution.then(
                    () => new Error("The timed-out process unexpectedly completed"),
                    (error: unknown) => error,
                );
                await started;

                await vi.advanceTimersByTimeAsync(3_000);
                await terminationRequested;
                await vi.advanceTimersByTimeAsync(1_000);

                await expect(outcome).resolves.toMatchObject({
                    code: "process_timeout",
                });
                const processId = Number(await readFile(marker, "utf8"));
                expect(() => process.kill(processId, 0)).toThrow();
            } finally {
                await rm(directory, { force: true, recursive: true });
            }
        },
    );
});
