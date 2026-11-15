import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// @no-uc: A cancelled external ACP startup must not leak a rejected promise into
// the Computer host's process-level fatal handler and terminate unrelated work.
test.for(["before-observation", "while-pending"])(
    "settles %s ACP startup cancellation and serves later settings in the same process",
    { timeout: 20_000 },
    async (cancellation, { signal }) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-acp-cancellation-"));
        const fixture = fileURLToPath(new URL("./fixtures/acp-cancellation-host.ts", import.meta.url));
        // The test's timeout kills a hung fixture.
        const child = spawn(process.execPath, [fixture, directory, cancellation], {
            env: { PATH: process.env["PATH"], HOME: directory, TMPDIR: directory },
            killSignal: "SIGKILL",
            signal,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        try {
            const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code, signal) => resolve({ code, signal }));
            });
            const artifact = resolve(process.env["MORTY_TEST_ARTIFACT_DIRECTORY"] ?? ".ci-artifacts/acp-cancellation");
            await mkdir(artifact, { recursive: true });
            await writeFile(
                join(artifact, `${cancellation}.json`),
                JSON.stringify({ cancellation, outcome, stdout, stderr }, null, 2),
            );
            expect(outcome, stderr).toEqual({ code: 0, signal: null });
            expect(stdout).toContain("cancelled-request-settled");
            expect(stdout).toContain("subsequent-settings-succeeded");
            expect(stderr).not.toContain("unhandled_rejection");
        } finally {
            child.kill("SIGKILL");
            await rm(directory, { force: true, recursive: true });
        }
    },
);
