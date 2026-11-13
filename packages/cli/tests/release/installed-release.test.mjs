import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
async function installedEntry() {
    if (process.env.MORTY_RELEASE_ENTRY) {
        return process.env.MORTY_RELEASE_ENTRY;
    }
    for (const bin of (process.env.PATH ?? "").split(delimiter)) {
        const candidate = join(bin, "..", "@morty-build", "cli", "dist", "cli.js");
        try {
            await access(candidate);
            return await realpath(candidate);
        } catch {
            /* Try the next npm bin directory. */
        }
    }
    throw new Error("Run the release test with the packed Morty package installed on PATH");
}
const entry = await installedEntry();
if (!entry) {
    throw new Error("MORTY_RELEASE_ENTRY must identify the installed release entrypoint");
}
const releaseVersion = JSON.parse(await readFile(join(dirname(entry), "../package.json"), "utf8")).version;

test("Given a packed Morty release, its help identifies the morty command", async () => {
    const morty = await mkdtemp(join(tmpdir(), "morty-release-"));
    try {
        const result = await execute(process.execPath, [entry, "--help"], {
            env: { ...process.env, MORTY_STATE_DIRECTORY: morty },
            timeout: 20_000,
        });
        assert.match(result.stdout, /^Usage: morty\b/m);
    } finally {
        await rm(morty, { recursive: true, force: true });
    }
});

test("Given a packed Morty release, its daemon starts once under concurrent starts, rejects unauthorized control, restarts and stops", async () => {
    const morty = await mkdtemp(join(tmpdir(), "morty-lifecycle-"));
    const env = { ...process.env, MORTY_STATE_DIRECTORY: morty };
    const run = (...args) => execute(process.execPath, [entry, ...args], { env, timeout: 180_000 });
    try {
        await Promise.all([run("start"), run("start"), run("start")]);
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
        const installation = join(morty, "computer");
        const hash = createHash("sha256").update(installation).digest("hex").slice(0, 32);
        const endpoint =
            process.platform === "win32"
                ? `\\\\.\\pipe\\morty-${hash}`
                : join(tmpdir(), `morty-${process.getuid()}`, `${hash}.sock`);
        const probe = createConnection(endpoint);
        await once(probe, "connect");
        const closed = once(probe, "close");
        probe.destroy();
        await closed;
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
        const unauthorized = createConnection(endpoint);
        try {
            await once(unauthorized, "connect");
            const reply = once(unauthorized, "data");
            unauthorized.write(`${JSON.stringify({ kind: "stop", token: "not-a-morty-control-token" })}\n`);
            const [response] = await reply;
            assert.equal(JSON.parse(response.toString()).code, "unauthorized");
        } finally {
            unauthorized.destroy();
        }
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
        await run("restart");
        assert.ok((await run("status")).stdout.includes(`Daemon: ${releaseVersion}\n`));
        await run("stop");
        assert.match((await run("status")).stdout, /Daemon: not running/);
        await writeFile(join(morty, "user-data"), "keep this file");
        await assert.rejects(access(join(morty, "executables")), { code: "ENOENT" });
        await access(join(morty, "user-data"));
    } finally {
        await run("stop").catch(() => undefined);
        await rm(morty, { recursive: true, force: true });
    }
});
