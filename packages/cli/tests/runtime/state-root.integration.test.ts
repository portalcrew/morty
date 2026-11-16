import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageMetadata from "../../package.json" with { type: "json" };
import { runCli } from "../support/cli-command.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

async function openedStateRoot(signal: AbortSignal): Promise<{
    readonly root: string;
    readonly installation: string;
    readonly home: string;
}> {
    const home = await mkdtemp(join(tmpdir(), "morty-state-root-"));
    temporaryDirectories.push(home);
    const root = join(home, "state");
    const env = environment(home, root);
    try {
        const started = await runCli(["start"], env, signal);
        expect(started.code, started.stderr).toBe(0);
    } finally {
        const stopped = await runCli(["quit"], env, signal);
        expect(stopped.code, stopped.stderr).toBe(0);
    }
    const application = join(root, "computer");
    return { root, installation: application, home };
}

function environment(home: string, stateDirectory: string): NodeJS.ProcessEnv {
    return { HOME: home, MORTY_STATE_DIRECTORY: stateDirectory, PATH: dirname(process.execPath), TMPDIR: home };
}

describe("Morty state root", () => {
    it.for(["release", "start"])(
        "Given the installation directory is a symlink, When the user runs %s, Then the CLI or Worker refuses without creating connection state in the link target",
        async (command, { signal }) => {
            const home = await mkdtemp(join(tmpdir(), "morty-version-container-"));
            temporaryDirectories.push(home);
            const root = join(home, "state");
            const target = join(home, "redirected");
            await mkdir(root, { recursive: true, mode: 0o700 });
            await mkdir(target, { mode: 0o700 });
            await symlink(target, join(root, "computer"), process.platform === "win32" ? "junction" : "dir");
            const env = environment(home, root);
            try {
                const result = await runCli([command], env, signal);

                expect(result.code).not.toBe(0);
                expect(await readdir(target)).toEqual([]);
            } finally {
                if (command === "start") {
                    await runCli(["quit"], env, signal);
                }
            }
        },
    );

    it.skipIf(process.platform === "win32")(
        "Given a user-owned installation directory allows other users to write, When the user releases idle Agent sessions, Then the CLI makes the container private before initializing state",
        async ({ signal }) => {
            const home = await mkdtemp(join(tmpdir(), "morty-version-container-"));
            temporaryDirectories.push(home);
            const root = join(home, "state");
            await runCli(["release"], environment(home, root), signal);
            const versionDirectory = join(root, "computer");
            await chmod(versionDirectory, 0o777);

            const listed = await runCli(["release"], environment(home, root), signal);

            expect(listed.code, listed.stderr).toBe(0);
            expect((await stat(versionDirectory)).mode & 0o777).toBe(0o700);
        },
    );

    it("Given an Agent environment whose MORTY_STATE_DIRECTORY names an installation's data, When Morty runs there, Then it refuses with a configuration error that names the owning root and creates nothing inside that data", async ({
        signal,
    }) => {
        const { root, installation, home } = await openedStateRoot(signal);
        const before = await readdir(installation);

        const listed = await runCli(["release"], environment(home, installation), signal);

        expect(listed.code).toBe(78);
        expect(listed.stderr).toContain(`MORTY_STATE_DIRECTORY=${root}`);
        expect(await readdir(installation)).toEqual(before);
    });

    it("Given an installation's data where an earlier nested Morty only left control files, When Morty runs there, Then it still refuses instead of treating it as a root", async ({
        signal,
    }) => {
        const { root, installation, home } = await openedStateRoot(signal);
        await mkdir(join(installation, "computer"), { recursive: true, mode: 0o700 });

        const listed = await runCli(["release"], environment(home, installation), signal);

        expect(listed.code).toBe(78);
        expect(listed.stderr).toContain(`MORTY_STATE_DIRECTORY=${root}`);
    });

    it("Given leftover files nested inside daemon data, When Morty is directed there as a state root, Then it refuses and retains those files", async ({
        signal,
    }) => {
        const { installation, home } = await openedStateRoot(signal);
        await mkdir(join(installation, "versions", packageMetadata.version), { recursive: true, mode: 0o700 });
        await writeFile(join(installation, "current-data.txt"), `versions/${packageMetadata.version}\n`, {
            mode: 0o600,
        });

        const listed = await runCli(["release"], environment(home, installation), signal);

        expect(listed.code).not.toBe(0);
        expect(await readFile(join(installation, "current-data.txt"), "utf8")).toBe(
            `versions/${packageMetadata.version}\n`,
        );
    });
});
