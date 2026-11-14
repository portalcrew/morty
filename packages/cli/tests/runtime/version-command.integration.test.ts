import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import cliPackage from "../../package.json" with { type: "json" };
import { sendLocalRequest } from "../../src/daemon/control/local-client.ts";
import { openMortyInstallation } from "../../src/daemon/pairing/pair-local-computer.ts";
import { runCli } from "../support/cli-command.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

describe("Morty version command", () => {
    it("Given no running daemon, When the user asks for the version, Then the CLI reports its own version and that no daemon is running", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-version-command-"));
        temporaryDirectories.push(directory);
        const environment = { ...process.env, MORTY_STATE_DIRECTORY: join(directory, "state") };
        const signal = AbortSignal.timeout(30_000);
        const expected = `CLI: ${cliPackage.version}\nDaemon: not running\n`;
        expect((await runCli(["--version"], environment, signal)).stdout).toBe(expected);
        expect((await runCli(["-v"], environment, signal)).stdout).toBe(expected);
    }, 60_000);

    it("Given a running daemon, When the user asks for the version, Then the CLI reports both the CLI and daemon versions", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-version-command-"));
        temporaryDirectories.push(directory);
        const environment = { ...process.env, MORTY_STATE_DIRECTORY: join(directory, "state") };
        const signal = AbortSignal.timeout(60_000);

        try {
            const started = await Promise.all(
                Array.from({ length: 4 }, async () => await runCli(["start"], environment, signal)),
            );
            for (const result of started) {
                expect(result.code, result.stderr).toBe(0);
            }
            const control = await openMortyInstallation(signal, environment);
            expect(await sendLocalRequest(control.stateDirectory, { kind: "reload" }, signal)).toEqual({
                kind: "reloaded",
            });
            expect(await sendLocalRequest(control.stateDirectory, { kind: "release" }, signal)).toEqual({
                kind: "released",
            });
            expect(
                await sendLocalRequest(
                    control.stateDirectory,
                    {
                        kind: "ensure",
                        launch: {
                            executable: process.execPath,
                            entry: resolve(import.meta.dirname, "../../dist/cli.js"),
                            version: cliPackage.version,
                        },
                    },
                    signal,
                ),
            ).toMatchObject({ kind: "error", code: "unsupported_operation" });
            const daemonPid = await readFile(join(control.stateDirectory, "daemon.lock"), "utf8");
            await expect(access(join(control.stateDirectory, "worker.lock"))).rejects.toMatchObject({ code: "ENOENT" });
            expect((await runCli(["start"], environment, signal)).code).toBe(0);
            expect(await readFile(join(control.stateDirectory, "daemon.lock"), "utf8")).toBe(daemonPid);
            await expect(access(join(environment.MORTY_STATE_DIRECTORY, "npm"))).rejects.toMatchObject({
                code: "ENOENT",
            });

            const reported = await runCli(["--version"], environment, signal);
            expect(reported.code).toBe(0);
            expect(reported.stderr).toBe("");
            expect(reported.stdout).toBe(`CLI: ${cliPackage.version}\nDaemon: ${cliPackage.version}\n`);
            expect((await runCli(["restart"], environment, signal)).code).toBe(0);
            expect(await readFile(join(control.stateDirectory, "daemon.lock"), "utf8")).not.toBe(daemonPid);
        } finally {
            await runCli(["quit"], environment, AbortSignal.timeout(10_000)).catch(() => undefined);
        }
    }, 90_000);
});
