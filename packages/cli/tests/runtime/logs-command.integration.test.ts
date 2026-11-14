import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../support/cli-command.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

/** Write the Computer's logs, mirroring the store's `<root>/computer/logs` layout. */
async function writeComputerLog(stateDirectory: string, filename: string, lines: readonly string[]): Promise<void> {
    const logs = join(stateDirectory, "computer", "logs");
    await mkdir(logs, { mode: 0o700, recursive: true });
    await writeFile(join(logs, filename), `${lines.join("\n")}\n`, { mode: 0o600 });
}

describe("Morty logs command", () => {
    // @no-uc: Technical regression; a bug report must include both Computer diagnostics and worker lifecycle evidence.
    it("Given a stopped daemon with logs from both the Computer and its manager, When the user collects them for a bug report, Then both logs are printed with its state-relative path", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeComputerLog(stateDirectory, "daemon-lifecycle.log", [
            'Morty worker lifecycle {"kind":"worker_started","pid":4242,"version":"0.0.272"}',
            'Morty worker lifecycle {"kind":"worker_exited","pid":4242,"exitCode":137,"signal":"SIGKILL","stderr":"/home/user/secret-path boom"}',
        ]);
        await writeComputerLog(stateDirectory, "daemon.log", [
            'Morty relay diagnostic {"event":"relay_connection_opened","computerId":"channel-1"}',
        ]);
        const environment = { ...process.env, MORTY_STATE_DIRECTORY: stateDirectory };

        const result = await runCli(["logs"], environment, AbortSignal.timeout(30_000));

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("daemon-lifecycle.log");
        expect(result.stdout).toContain("daemon.log");
        expect(result.stdout).toContain("worker_started");
        expect(result.stdout).toContain("relay_connection_opened");
        // Paths are reported relative to the state root so a shared report never
        // carries the collector's home directory.
        expect(result.stdout).not.toContain(stateDirectory);
        expect(result.stdout).toContain("computer/");
        expect(result.stdout).toContain("Review them before sharing");
    }, 60_000);

    it("Given a linked log beside an ordinary log, When the user exports diagnostics, Then only the ordinary log is included", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeComputerLog(stateDirectory, "daemon.log", ["ordinary-log"]);
        const outside = join(directory, "private.txt");
        await writeFile(outside, "must-not-be-exported", { mode: 0o600 });
        await symlink(outside, join(stateDirectory, "computer", "logs", "linked.log"));

        const result = await runCli(
            ["logs", "--json", "--state-directory", stateDirectory],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            entries: [expect.objectContaining({ lines: ["ordinary-log"], omittedLines: 0 })],
            unreadable: [],
        });
        expect(result.stdout).not.toContain("must-not-be-exported");
    }, 60_000);

    // @no-uc: Technical regression; bounded log tailing must report what it dropped rather than hide it.
    it("Given more log lines than the requested tail, When the user collects them, Then the oldest lines are reported as omitted instead of printed", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeComputerLog(stateDirectory, "daemon.log", [
            "oldest-line-should-be-dropped",
            "newest-line-should-be-kept",
        ]);

        const result = await runCli(
            ["logs", "--tail", "1", "--state-directory", stateDirectory],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("newest-line-should-be-kept");
        expect(result.stdout).not.toContain("oldest-line-should-be-dropped");
        expect(result.stdout).toContain("1 earlier line(s) omitted");
    }, 60_000);

    // @no-uc: Technical regression; machine-readable log export must keep stdout parseable for evidence pipelines.
    it("Given logs collected as JSON, When the output is piped, Then stdout is machine-parseable and the sharing notice goes to stderr", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeComputerLog(stateDirectory, "daemon.log", ['{"event":"relay_connection_opened"}']);

        const result = await runCli(
            ["logs", "--json", "--state-directory", stateDirectory],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toContain("Review them before sharing");
        const parsed: unknown = JSON.parse(result.stdout);
        expect(parsed).toEqual({
            entries: [expect.objectContaining({ lines: ['{"event":"relay_connection_opened"}'], omittedLines: 0 })],
            unreadable: [],
        });
    }, 60_000);

    // @no-uc: Technical regression; a forensic log export must not mutate the files it reads.
    it("Given logs with permissions the daemon did not tighten, When the user collects them, Then collection is read-only and the file modes are unchanged", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeComputerLog(stateDirectory, "daemon.log", ['{"event":"relay_connection_opened"}']);
        const logPath = join(stateDirectory, "computer", "logs", "daemon.log");
        const directoryPath = dirname(logPath);
        // Widen both deliberately: `validateLocalPath(path, ..., privateAccess: true)`
        // repairs modes with chmod, which would silently hide this difference.
        await chmod(logPath, 0o644);
        await chmod(directoryPath, 0o755);

        const result = await runCli(
            ["logs", "--state-directory", stateDirectory],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("relay_connection_opened");
        expect((await stat(logPath)).mode & 0o777).toBe(0o644);
        expect((await stat(directoryPath)).mode & 0o777).toBe(0o755);
    }, 60_000);

    // @no-uc: Technical regression; unreadable evidence must not be reported as absent.
    it("Given a log the collector cannot read, When the user collects logs, Then the report names the missing file and fails instead of claiming no logs exist", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeComputerLog(stateDirectory, "daemon.log", ['{"event":"relay_connection_opened"}']);
        const logPath = join(stateDirectory, "computer", "logs", "daemon.log");
        // Simulates the read-only mount or failing-disk case the export has to
        // survive: the file is present but this user cannot read it.
        await chmod(logPath, 0o000);
        try {
            const result = await runCli(
                ["logs", "--state-directory", stateDirectory],
                process.env,
                AbortSignal.timeout(30_000),
            );

            expect(result.code).toBe(1);
            expect(result.stdout).toContain("The local daemon logs could not be read.");
            expect(result.stdout).not.toContain("No local daemon logs were found.");
            expect(result.stderr).toContain("could not be read and are missing from this report");
            expect(result.stderr).toContain("daemon.log");

            const reported = await runCli(
                ["logs", "--json", "--state-directory", stateDirectory],
                process.env,
                AbortSignal.timeout(30_000),
            );
            // JSON mode is the machine-consumable path, so it has to carry the same
            // failure status; a collector keying on the exit code cannot be fooled
            // by the format flag.
            expect(reported.code).toBe(1);
            const parsed = JSON.parse(reported.stdout) as {
                readonly entries: unknown[];
                readonly unreadable: string[];
            };
            expect(parsed.entries).toEqual([]);
            expect(parsed.unreadable).toEqual(["computer/logs/daemon.log"]);
        } finally {
            await chmod(logPath, 0o600);
        }
    }, 60_000);

    // @no-uc: Technical regression; an unlistable log directory must count as a collection failure.
    it("Given a log directory this user cannot list, When the user collects logs, Then the directory is reported unreadable instead of being treated as holding no logs", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeComputerLog(stateDirectory, "daemon.log", ['{"event":"relay_connection_opened"}']);
        // The logs directory exists and holds a readable file, but cannot be
        // enumerated: an owner-writable, not owner-readable mode (0o300). Treating
        // this as "no logs here" is what hid the evidence before.
        const logsDirectory = join(stateDirectory, "computer", "logs");
        await chmod(logsDirectory, 0o300);
        try {
            const result = await runCli(
                ["logs", "--state-directory", stateDirectory],
                process.env,
                AbortSignal.timeout(30_000),
            );

            expect(result.code).toBe(1);
            expect(result.stdout).toContain("The local daemon logs could not be read.");
            expect(result.stdout).not.toContain("No local daemon logs were found.");
            expect(result.stderr).toContain("computer/logs");
        } finally {
            await chmod(logsDirectory, 0o700);
        }
    }, 60_000);

    // @no-uc: Technical regression; a clean computer must report no logs distinctly from an unreadable one.
    it("Given no daemon has ever run here, When the user collects logs, Then the command reports that nothing was found instead of failing", async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-logs-command-"));
        temporaryDirectories.push(directory);

        const result = await runCli(
            ["logs", "--state-directory", join(directory, "unused")],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("No local daemon logs were found.");
    }, 60_000);
});
