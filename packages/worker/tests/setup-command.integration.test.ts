import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { expect, test } from "vitest";
import { createIdentityFixture } from "./support/identity-fixture.ts";

// Windows terminates a child immediately for SIGTERM instead of delivering a cancellable POSIX signal.
test.runIf(process.platform !== "win32")(
    "Given an installed Morty CLI without npm on PATH, When the user runs setup then cancels after identity creation, Then the CLI preserves the private identity and can revoke its shared access",
    {
        timeout: 90_000,
    },
    async ({ signal }) => {
        await using cleanup = new AsyncDisposableStack();
        const fixture = await createIdentityFixture({ listenOnLoopback: true });
        cleanup.defer(() => fixture.close());
        const directory = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-command-")));
        cleanup.defer(() => rm(directory, { recursive: true, force: true }));
        const state = join(directory, "state");
        const workspace = join(directory, "workspace with spaces ' &");
        await mkdir(workspace);
        const entry = fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url));
        const environment = {
            ...process.env,
            PATH: "",
            MORTY_STATE_DIRECTORY: state,
            CODEX_THREAD_ID: "setup-command-session",
        };
        const run = async (args: readonly string[], cancelAfterIdentity = false) => {
            const child = spawn(process.execPath, [entry, ...args], {
                cwd: workspace,
                env: environment,
                signal,
                stdio: ["ignore", "pipe", "pipe"],
            });
            const closed = once(child, "close");
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                stdout += chunk;
                if (cancelAfterIdentity && stdout.includes('"status":"identity_ready"')) {
                    child.kill("SIGTERM");
                    cancelAfterIdentity = false;
                }
            });
            child.stderr.on("data", (chunk: string) => {
                stderr += chunk;
            });
            const [code] = await closed;
            return { code, stdout, stderr };
        };

        const setup = await run(["setup", "--base-url", fixture.origin, "--harness", "codex"], true);
        expect(setup.code, setup.stderr).toBe(1);
        expect(setup.stdout).toContain('"status":"runtime_verified"');
        expect(setup.stdout).toContain('"status":"identity_ready"');
        expect(setup.stdout).toContain('"code":"CANCELLED"');
        const configuration = v.parse(
            v.object({
                base_url: v.string(),
                identity: v.object({ computer_token: v.string(), computer_id: v.string() }),
            }),
            JSON.parse(await readFile(join(state, "config.json"), "utf8")),
        );
        expect(configuration.base_url).toBe(fixture.origin);
        expect(setup.stdout).not.toContain(configuration.identity.computer_token);

        const revoked = await run(["revoke-all-access"]);
        expect(revoked.code, revoked.stderr).toBe(0);
        expect(revoked.stdout).toContain('"status":"access_revoked"');
        expect(revoked.stdout).not.toContain(configuration.identity.computer_token);
        expect(JSON.parse(await readFile(join(state, "config.json"), "utf8"))).toMatchObject({
            identity: {
                computer_id: configuration.identity.computer_id,
                computer_token: expect.not.stringMatching(configuration.identity.computer_token),
            },
        });
    },
);
