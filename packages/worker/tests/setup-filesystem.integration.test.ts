import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as v from "valibot";
import { beforeAll, expect, test } from "vitest";
import { mortyReply } from "../../../tests/support/fake-daemon/scenarios.ts";
import { ControlledSetupRuntime } from "../../e2e/infra/setup-daemon.ts";
import worker from "../src/worker/application.ts";
import { prepareIdentityFixture } from "./support/identity-fixture.ts";

const localRuntimeModule = JSON.stringify(new URL("../../cli/src/setup/local-runtime.ts", import.meta.url).href);
const builtCli = JSON.stringify(fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url)));

async function writeSetupRunner(directory: string): Promise<string> {
    const entry = join(directory, "run-setup.mjs");
    await writeFile(
        entry,
        `
import { runSetup } from ${JSON.stringify(new URL("../../cli/src/setup/setup.ts", import.meta.url).href)};
import { localSetupRuntime } from ${localRuntimeModule};
const cancellation = new AbortController();
process.once('SIGINT', () => cancellation.abort());
process.once('SIGTERM', () => cancellation.abort());
process.exitCode = await runSetup(process.argv.slice(2), {
    state: process.env.MORTY_STATE_DIRECTORY,
    runtime: localSetupRuntime(${builtCli}),
    signal: cancellation.signal,
    emit: event => console.log(JSON.stringify(event)),
});
`,
    );
    return entry;
}

// Budgets for the scenarios that run Setup as a child process. CI also runs some of them on Windows, the slowest
// relay: there each run checks path permissions through PowerShell, which Morty bounds at 30 s per check, and a
// fixture's first workerd start has taken over 10 s. The child's deadline leaves room for one check to reach that
// bound and for the run to finish and report. The test's timeout adds room to start the fixture and to clean up.
const SETUP_PROCESS_TIMEOUT_MS = 60_000;
const SETUP_PROCESS_TEST_TIMEOUT_MS = 90_000;

let createIdentityFixture: Awaited<ReturnType<typeof prepareIdentityFixture>>;
beforeAll(async () => {
    createIdentityFixture = await prepareIdentityFixture({ listenOnLoopback: true });
});

interface SetupModule {
    readonly runSetup: (
        args: readonly string[],
        host: {
            readonly state: string;
            readonly agentEnvironment?: Readonly<Record<string, string | undefined>>;
            readonly signal: AbortSignal;
            readonly runtime?: ControlledSetupRuntime;
            readonly clock?: {
                readonly now: () => Date;
                readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
            };
            readonly emit: (event: Readonly<Record<string, unknown>>) => void;
        },
    ) => Promise<number>;
}

function isSetupModule(value: unknown): value is SetupModule {
    return value !== null && typeof value === "object" && "runSetup" in value && typeof value.runSetup === "function";
}

// Load the Node workflow at runtime rather than typechecking it with the Worker's Cloudflare globals.
const setupModule: unknown = await import(new URL("../../cli/src/setup/setup.ts", import.meta.url).href);
if (!isSetupModule(setupModule)) {
    throw new Error("Missing setup entrypoint");
}
const { runSetup } = setupModule;

type SavedReplacement =
    | { readonly kind: "unchanged" | "unknown" }
    | {
          readonly kind: "revoked";
          readonly previous:
              | { readonly kind: "pending"; readonly computer_id: string; readonly computer_token: string }
              | { readonly kind: "retired"; readonly computer_id: string };
      };

/** The saved setup state of a ready identity, in the representation setup writes. */
function savedSetupState(
    origin: string,
    identity: { readonly token: string; readonly computerId: string },
    replacement: SavedReplacement = { kind: "unchanged" },
) {
    return JSON.stringify({
        version: 4,
        base_url: origin,
        identity: {
            kind: "ready",
            computer_token: identity.token,
            computer_id: identity.computerId,
            pairing: { kind: "none" },
            replacement,
        },
    });
}

/** The ready identity setup saved in a state directory. */
async function savedIdentity(state: string) {
    const saved = v.parse(
        v.object({
            identity: v.object({
                kind: v.literal("ready"),
                computer_id: v.string(),
                computer_token: v.string(),
                replacement: v.unknown(),
            }),
        }),
        JSON.parse(await readFile(join(state, "config.json"), "utf8")),
    );
    return saved.identity;
}

test.each(["fresh", "unknown", "revoked"] as const)(
    "Given an invalid Morty state root and %s replacement state, When setup stops at preflight, Then it preserves the identity and accurately reports earlier shared access",
    {
        timeout: SETUP_PROCESS_TEST_TIMEOUT_MS,
    },
    async (replacementState) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-setup-state-root-"));
        // The shell names the installation data of another state root, which Morty refuses.
        const owner = join(directory, "owner");
        const state = join(owner, "computer");
        await mkdir(owner, { recursive: true, mode: 0o700 });
        await writeFile(join(owner, "config.json"), "{}", { mode: 0o600 });
        const fixture = await createIdentityFixture();
        try {
            if (replacementState !== "fresh") {
                const previous = await fixture.createAnonymousUser();
                const current =
                    replacementState === "unknown"
                        ? previous
                        : v.parse(
                              v.pipe(
                                  v.object({ computerId: v.string(), computerToken: v.string() }),
                                  v.transform(({ computerId, computerToken }) => ({
                                      computerId,
                                      token: computerToken,
                                  })),
                              ),
                              await (
                                  await worker.fetch(
                                      new Request(
                                          `${fixture.origin}/morty/api/v1/computers/${previous.computerId}/replacement`,
                                          { method: "POST", headers: { authorization: `Bearer ${previous.token}` } },
                                      ),
                                      fixture.environment(fixture.origin),
                                  )
                              ).json(),
                          );
                await mkdir(state, { recursive: true, mode: 0o700 });
                await writeFile(
                    join(state, "config.json"),
                    savedSetupState(
                        fixture.origin,
                        current,
                        replacementState === "unknown"
                            ? { kind: "unknown" }
                            : { kind: "revoked", previous: { kind: "retired", computer_id: previous.computerId } },
                    ),
                    { mode: 0o600 },
                );
            }
            const saved = replacementState === "fresh" ? null : await readFile(join(state, "config.json"), "utf8");
            const runner = await writeSetupRunner(directory);
            let output = "";
            const child = spawn(
                process.execPath,
                [
                    runner,
                    "setup",
                    "--base-url",
                    fixture.origin,
                    "--cwd",
                    directory,
                    "--harness",
                    "codex",
                    "--session-id",
                    "state-root-test",
                ],
                {
                    env: {
                        ...process.env,
                        MORTY_STATE_DIRECTORY: state,
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                    signal: AbortSignal.timeout(SETUP_PROCESS_TIMEOUT_MS),
                    windowsHide: true,
                },
            );
            child.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
                output += chunk.toString();
            });
            const [code] = await once(child, "close");
            expect(code, output).toBe(1);
            expect(output).toContain('"code":"MORTY_STATE_ROOT_INVALID"');
            expect(output).toContain("Rerun setup with MORTY_STATE_DIRECTORY set to the owning state root");
            expect(output).not.toContain('"status":"identity_ready"');
            if (saved === null) {
                await expect(readFile(join(state, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
                expect(output).toContain("existing Morty links keep working");
            } else {
                expect(await readFile(join(state, "config.json"), "utf8")).toBe(saved);
                expect(output).toContain(`"kind":"${replacementState}"`);
                expect(output).not.toContain("existing Morty links keep working");
                expect(output).toContain('"setupReady":false');
            }
        } finally {
            await fixture.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

test("Given a local workspace and a private state directory, When setup creates its identity and the user cancels, Then credentials remain private and can be reused", {
    timeout: SETUP_PROCESS_TEST_TIMEOUT_MS,
}, async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-setup-filesystem-"));
    const state = join(directory, "state ' & workspace");
    const workspace = join(directory, "workspace with spaces & quotes '");
    await mkdir(workspace);
    const fixture = await createIdentityFixture();
    const runner = join(directory, "run-setup.mjs");
    await writeFile(
        runner,
        `
import { runSetup } from ${JSON.stringify(new URL("../../cli/src/setup/setup.ts", import.meta.url).href)};
import { localSetupRuntime } from ${localRuntimeModule};
const cancellation = new AbortController();
process.exitCode = await runSetup(process.argv.slice(2), {
    state: process.env.MORTY_STATE_DIRECTORY,
    runtime: localSetupRuntime(${builtCli}),
    agentEnvironment: {},
    signal: cancellation.signal,
    emit(event) {
        console.log(JSON.stringify(event));
        if (event.status === 'identity_ready') cancellation.abort(new Error('User cancelled setup'));
    },
});
`,
    );
    const child = spawn(
        process.execPath,
        [
            runner,
            "setup",
            "--base-url",
            fixture.origin,
            "--cwd",
            workspace,
            "--harness",
            "codex",
            "--session-id",
            "native-setup",
        ],
        {
            env: {
                ...process.env,
                MORTY_STATE_DIRECTORY: state,
            },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            signal: AbortSignal.timeout(SETUP_PROCESS_TIMEOUT_MS),
        },
    );
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    child.stderr.resume();
    try {
        const [code] = await exited;
        const events = output
            .trim()
            .split("\n")
            .map((line) => v.parse(v.record(v.string(), v.unknown()), JSON.parse(line)));
        expect(code).toBe(1);
        expect(events).toContainEqual(expect.objectContaining({ status: "identity_ready" }));
        expect(events.at(-1)).toMatchObject({ error: { code: "CANCELLED" } });
        const configPath = join(state, "config.json");
        const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
        expect(config).toMatchObject({
            base_url: fixture.origin,
            identity: { kind: "ready", computer_token: expect.stringMatching(/^morty_computer_v1_/u) },
        });
        if (process.platform === "win32") {
            const execute = promisify(execFile);
            const { stdout } = await execute(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'); $a = Get-Acl -LiteralPath $env:MORTY_TEST_CONFIG; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; if (-not $a.AreAccessRulesProtected) { exit 1 }; if (@($a.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -ne $sid }).Count -gt 0) { exit 2 }; 'private'",
                ],
                {
                    env: { ...process.env, MORTY_TEST_CONFIG: configPath },
                    windowsHide: true,
                    signal: AbortSignal.timeout(10000),
                    timeout: 10000,
                },
            );
            expect(stdout.trim()).toBe("private");
        } else {
            expect((await stat(configPath)).mode & 0o777).toBe(0o600);
        }
    } finally {
        child.kill();
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("Given a junction replaces the private Morty directory, When setup validates its local state, Then it refuses to write credentials through the link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-setup-link-"));
    const state = join(directory, "state");
    const target = join(directory, "target");
    await mkdir(target);
    await symlink(target, state, process.platform === "win32" ? "junction" : "dir");
    const events: Readonly<Record<string, unknown>>[] = [];
    try {
        expect(
            await runSetup(
                [
                    "setup",
                    "--base-url",
                    "http://127.0.0.1:1",
                    "--cwd",
                    directory,
                    "--harness",
                    "codex",
                    "--session-id",
                    "native-setup",
                ],
                {
                    state,
                    agentEnvironment: {},
                    signal: new AbortController().signal,
                    emit: (event) => events.push(event),
                },
            ),
        ).toBe(1);
        expect(events.at(-1)).toMatchObject({ error: { code: "UNSAFE_CONFIG_PATH" } });
        await expect(stat(join(target, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test.runIf(process.platform !== "win32")(
    "Given HOME and no overrides, When a user runs the setup CLI, Then identity is saved in the relay's local state directory and cancellation releases setup",
    { timeout: SETUP_PROCESS_TEST_TIMEOUT_MS },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "morty-setup-home-"));
        const state =
            process.platform === "darwin"
                ? join(directory, "Library", "Application Support", "Morty", "v3")
                : join(directory, ".local", "state", "morty", "v3");
        const workspace = join(directory, "workspace");
        await mkdir(workspace);
        const fixture = await createIdentityFixture();
        const environment = Object.fromEntries(
            Object.entries(process.env).filter(([name]) => !["MORTY_STATE_DIRECTORY", "XDG_STATE_HOME"].includes(name)),
        );
        const child = spawn(
            process.execPath,
            [
                fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url)),
                "setup",
                "--base-url",
                fixture.origin,
                "--cwd",
                workspace,
                "--harness",
                "codex",
                "--session-id",
                "xdg-current-session",
            ],
            {
                env: {
                    ...environment,
                    HOME: directory,
                },
                stdio: ["ignore", "pipe", "pipe"],
                signal: AbortSignal.timeout(SETUP_PROCESS_TIMEOUT_MS),
            },
        );
        const exited = once(child, "exit");
        let output = "";
        let cancellationRequested = false;
        child.stdout.on("data", (chunk) => {
            output += chunk.toString();
            if (!cancellationRequested && output.includes('"status":"identity_ready"')) {
                cancellationRequested = true;
                child.kill("SIGINT");
            }
        });
        child.stderr.resume();
        try {
            const [code] = await exited;
            expect(code, output).toBe(1);
            expect(output).toContain('"status":"identity_ready"');
            const saved: unknown = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
            expect(saved).toMatchObject({ base_url: fixture.origin });
            expect((await stat(state)).mode & 0o777).toBe(0o700);
            expect(output).toContain('"code":"CANCELLED"');
        } finally {
            child.kill();
            await fixture.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);

test.runIf(process.env["MORTY_VERIFY_SYSTEM_STATE"] === "true" && process.platform === "darwin")(
    "Given MORTY_STATE_DIRECTORY is unset on macOS, When setup connects and the user cancels, Then the private identity is saved under ~/Library/Application Support/Morty",
    async () => {
        if (process.env["CI"] !== "true" || process.env["MORTY_STATE_DIRECTORY"] !== undefined) {
            throw new Error("System state verification requires an isolated CI runner without MORTY_STATE_DIRECTORY");
        }
        const configuration = join(homedir(), "Library", "Application Support", "Morty");
        try {
            await stat(configuration);
            throw new Error("Refusing to overwrite existing Morty configuration");
        } catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
                throw cause;
            }
        }
        const workspace = await mkdtemp(join(tmpdir(), "morty-macos-workspace-"));
        const fixture = await createIdentityFixture();
        const cancellation = new AbortController();
        const events: Readonly<Record<string, unknown>>[] = [];
        try {
            const code = await runSetup(
                [
                    "setup",
                    "--base-url",
                    fixture.origin,
                    "--cwd",
                    workspace,
                    "--harness",
                    "codex",
                    "--session-id",
                    "macos-current-session",
                ],
                {
                    state: "",
                    agentEnvironment: {},
                    signal: cancellation.signal,
                    emit: (event) => {
                        events.push(event);
                        if (event["status"] === "identity_ready") {
                            cancellation.abort();
                        }
                    },
                },
            );
            expect(code).toBe(1);
            expect(events).toContainEqual(expect.objectContaining({ status: "identity_ready" }));
            expect(events.at(-1)).toMatchObject({ error: { code: "CANCELLED" } });
            const saved: unknown = JSON.parse(await readFile(join(configuration, "config.json"), "utf8"));
            expect(saved).toMatchObject({ base_url: fixture.origin });
            expect((await stat(join(configuration, "config.json"))).mode & 0o777).toBe(0o600);
        } finally {
            await fixture.close();
            await rm(configuration, { recursive: true, force: true });
            await rm(workspace, { recursive: true, force: true });
        }
    },
);

for (const segments of [4, 8]) {
    test.skipIf(segments === 8 && process.platform !== "linux")(
        `Given a valid ${segments}-segment multibyte workspace, When setup prepares the handoff, Then it delivers the normal link even when no QR can represent it`,
        { timeout: 30_000 },
        async () => {
            const root = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-long-")));
            const state = join(root, "state");
            const workspace = join(
                root,
                ...Array.from({ length: segments }, () => "\u00e9".repeat(segments === 8 ? 110 : 90)),
            );
            await mkdir(workspace, { recursive: true });
            const fixture = await createIdentityFixture();
            const runtime = new ControlledSetupRuntime(
                { harness: "codex", agentName: "Codex", reply: mortyReply },
                "Setup test Computer",
            );
            const events: Readonly<Record<string, unknown>>[] = [];
            let time = Date.parse("2026-09-15T12:00:00Z");
            try {
                const code = await runSetup(
                    [
                        "setup",
                        "--base-url",
                        fixture.origin,
                        "--cwd",
                        workspace,
                        "--harness",
                        "codex",
                        "--session-id",
                        "native-long-project",
                    ],
                    {
                        state,
                        agentEnvironment: {},
                        signal: AbortSignal.timeout(25_000),
                        runtime,
                        emit: (event) => events.push(event),
                        clock: {
                            now: () => new Date(time),
                            wait: async (milliseconds, signal) => {
                                signal.throwIfAborted();
                                time += milliseconds;
                            },
                        },
                    },
                );
                expect(code, JSON.stringify(events)).toBe(0);
                const ready = events.at(-1);
                expect(ready).toMatchObject({ status: "ready", workspace });
                const link = ready?.["url"];
                if (typeof link !== "string") {
                    throw new Error("Missing setup link");
                }
                const handoff = new URL(link);
                expect(handoff.searchParams.has("workspace")).toBe(false);
                expect(new URLSearchParams(handoff.hash.slice(1)).get("workspace")).toBe(workspace);
                const documentRequest = Promise.withResolvers<string>();
                const proxy = createServer((incoming, outgoing) => {
                    documentRequest.resolve(incoming.url ?? "");
                    const forwarded = request(new URL(incoming.url ?? "/", fixture.origin), (response) => {
                        outgoing.writeHead(response.statusCode ?? 502, response.headers);
                        response.pipe(outgoing);
                    });
                    forwarded.on("error", (cause) => outgoing.destroy(cause));
                    incoming.pipe(forwarded);
                });
                await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
                try {
                    const address = proxy.address();
                    if (address === null || typeof address === "string") {
                        throw new Error("Expected a listening document proxy");
                    }
                    const documentUrl = new URL(link);
                    documentUrl.host = `127.0.0.1:${address.port}`;
                    const response = await fetch(documentUrl, { signal: AbortSignal.timeout(10_000) });
                    await response.arrayBuffer();
                    const target = await documentRequest.promise;
                    expect(new URL(target, fixture.origin).searchParams.has("workspace")).toBe(false);
                    expect(target).not.toContain(encodeURIComponent(workspace));
                } finally {
                    await new Promise<void>((resolve, reject) =>
                        proxy.close((error) => (error === undefined ? resolve() : reject(error))),
                    );
                }
                if (segments === 8) {
                    expect(ready).toMatchObject({ qrPath: null });
                    expect(events).toContainEqual(
                        expect.objectContaining({
                            status: "qr_unavailable",
                            error: expect.objectContaining({ code: "QR_UNAVAILABLE" }),
                        }),
                    );
                }
            } finally {
                await runtime.disconnect();
                await fixture.close();
                const qrPath = events.at(-1)?.["qrPath"];
                if (typeof qrPath === "string") {
                    await rm(qrPath, { force: true });
                }
                await rm(root, { recursive: true, force: true });
            }
        },
    );
}

async function setupComputer(
    runtime: ControlledSetupRuntime,
    paths: {
        readonly origin: string;
        readonly state: string;
        readonly workspace: string;
    },
    deadline?: (milliseconds: number) => AbortSignal,
    run: {
        readonly harness?: string;
        /** The Computer whose replacement the user explicitly approved. */
        readonly replaceComputer?: string;
        /** The `--session-id` the agent passes; `null` passes none. */
        readonly sessionArgument?: string | null;
        /** The calling agent's shell environment, where a harness exposes its current session. */
        readonly agentEnvironment?: Readonly<Record<string, string>>;
        /** The user stops setup as soon as it reports this status. */
        readonly interruptAt?: string;
        /** Runs before setup's clock moves on, with every event setup reported so far. */
        readonly whileWaiting?: (events: readonly Readonly<Record<string, unknown>>[]) => Promise<void>;
        /** From this progress stage on, the network stalls and every deadline setup starts has already passed. */
        readonly stallFromStage?: string;
    } = {},
): Promise<{ readonly code: number; readonly events: readonly Readonly<Record<string, unknown>>[] }> {
    const events: Readonly<Record<string, unknown>>[] = [];
    let time = Date.parse("2026-10-22T12:00:00Z");
    const interrupt = new AbortController();
    const code = await runSetup(
        [
            "setup",
            "--base-url",
            paths.origin,
            "--cwd",
            paths.workspace,
            "--harness",
            run.harness ?? "settings-test",
            ...(run.replaceComputer === undefined ? [] : ["--replace-computer", run.replaceComputer]),
            ...(run.sessionArgument === null ? [] : ["--session-id", run.sessionArgument ?? "native-upgrade-project"]),
        ],
        {
            state: paths.state,
            agentEnvironment: run.agentEnvironment ?? {},
            signal: AbortSignal.any([interrupt.signal, AbortSignal.timeout(55_000)]),
            runtime,
            emit: (event) => {
                events.push(event);
                if (run.interruptAt !== undefined && event["status"] === run.interruptAt) {
                    interrupt.abort(new Error("The user stopped setup."));
                }
            },
            clock: {
                now: () => new Date(time),
                wait: async (milliseconds, signal) => {
                    signal.throwIfAborted();
                    await run.whileWaiting?.(events);
                    time += milliseconds;
                },
                ...(deadline === undefined && run.stallFromStage === undefined
                    ? {}
                    : {
                          deadline: (milliseconds: number) =>
                              run.stallFromStage !== undefined &&
                              events.some((event) => event["stage"] === run.stallFromStage)
                                  ? AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"))
                                  : (deadline ?? AbortSignal.timeout)(milliseconds),
                      }),
            },
        },
    );
    const qrPath = events.at(-1)?.["qrPath"];
    if (typeof qrPath === "string") {
        await rm(qrPath, { force: true });
    }
    return { code, events };
}

async function withSetupComputer(
    scenario: (
        runtime: ControlledSetupRuntime,
        paths: {
            readonly origin: string;
            readonly state: string;
            readonly workspace: string;
            readonly dispatch: (request: Request) => Promise<Response>;
        },
    ) => Promise<void>,
): Promise<void> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "morty-setup-computer-")));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const fixture = await createIdentityFixture();
    const runtime = new ControlledSetupRuntime(
        { harness: "settings-test", agentName: "Settings Agent", reply: mortyReply },
        "Setup test Computer",
    );
    try {
        await scenario(runtime, {
            origin: fixture.origin,
            state: join(root, "state"),
            workspace,
            dispatch: async (request) => await worker.fetch(request, fixture.environment(fixture.origin)),
        });
    } finally {
        await runtime.disconnect();
        await fixture.close();
        await rm(root, { recursive: true, force: true });
    }
}

test("Given a paired computer whose daemon is online, When the user reruns setup, Then setup reuses the running Computer without restarting it", {
    timeout: 90_000,
}, async () => {
    await withSetupComputer(async (runtime, paths) => {
        const first = await setupComputer(runtime, paths);
        expect(first.code, JSON.stringify(first.events)).toBe(0);

        const rerun = await setupComputer(runtime, paths);
        expect(rerun.code, JSON.stringify(rerun.events)).toBe(0);
        expect(rerun.events).toContainEqual(expect.objectContaining({ status: "computer_already_online" }));
        expect(rerun.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
    });
});

test("Given setup was stopped after pairing its Computer, When the user runs setup again and again, Then each run continues on that Computer and setup finishes", {
    timeout: 120_000,
}, async () => {
    await withSetupComputer(async (runtime, paths) => {
        // Pairing stops at eight Computers; each stopped run must not leave another one behind.
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            const stopped = await setupComputer(runtime, paths, undefined, { interruptAt: "computer_paired" });
            expect(stopped.code, JSON.stringify(stopped.events)).not.toBe(0);
        }
        const finished = await setupComputer(runtime, paths);
        expect(finished.code, JSON.stringify(finished.events)).toBe(0);
        expect(finished.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
    });
});

test("Given a shared Computer whose local pairing was removed, When setup has no matching replacement approval, Then shared access stays valid until the user approves that Computer", {
    timeout: 120_000,
}, async () => {
    await withSetupComputer(async (runtime, paths) => {
        const first = await setupComputer(runtime, paths);
        expect(first.code, JSON.stringify(first.events)).toBe(0);
        const config = await savedIdentity(paths.state);
        const saved = await readFile(join(paths.state, "config.json"), "utf8");
        const url = v.parse(v.string(), first.events.at(-1)?.["url"]);
        const redeem = async () =>
            await paths.dispatch(
                new Request(`${paths.origin}/morty/api/v1/identity/transfers/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code: new URLSearchParams(new URL(url).hash.slice(1)).get("code") }),
                    signal: AbortSignal.timeout(10000),
                }),
            );
        const redeemed = await redeem();
        expect(redeemed.status).toBe(200);
        const browser = v.parse(v.object({ computerToken: v.string() }), await redeemed.json());
        const session = async () =>
            await fetch(`${paths.origin}/morty/api/v1/computers/${config.computer_id}/session`, {
                headers: { authorization: `Bearer ${browser.computerToken}` },
                signal: AbortSignal.timeout(10000),
            });
        await runtime.forgetConnections();

        for (const replaceComputer of [undefined, "another-computer"]) {
            const blocked = await setupComputer(runtime, paths, undefined, {
                ...(replaceComputer === undefined ? {} : { replaceComputer }),
            });
            expect(blocked.code).toBe(1);
            expect(blocked.events.at(-1)).toMatchObject({
                error: {
                    code: "COMPUTER_REPLACEMENT_REQUIRED",
                    replacement: { computerId: config.computer_id, reason: "managed_computer_missing" },
                },
            });
            expect((await session()).status).toBe(200);
            expect(await readFile(join(paths.state, "config.json"), "utf8")).toBe(saved);
        }

        const approved = await setupComputer(runtime, paths, undefined, { replaceComputer: config.computer_id });
        expect(approved.code, JSON.stringify(approved.events)).toBe(0);
        expect(approved.events).toContainEqual(
            expect.objectContaining({ status: "replacement_access_revoked", previousComputerId: config.computer_id }),
        );
        expect(approved.events.at(-1)).toMatchObject({ status: "ready", computer: "replaced" });
        const retired = await fetch(`${paths.origin}/morty/api/v1/computers/${config.computer_id}/session`, {
            headers: { authorization: `Bearer ${config.computer_token}` },
            signal: AbortSignal.timeout(10000),
        });
        expect(retired.status).toBe(401);
        expect((await session()).status).toBe(401);
        expect((await redeem()).status).toBe(410);
        const current = await savedIdentity(paths.state);
        expect(current.computer_id).not.toBe(config.computer_id);
        const diagnostics = approved.events.filter((event) => event["status"] !== "ready");
        expect(JSON.stringify(diagnostics)).not.toContain(config.computer_token);
        expect(JSON.stringify(diagnostics)).not.toContain(browser.computerToken);
        expect(JSON.stringify(diagnostics)).not.toContain(url);

        await runtime.forgetConnections();
        const stale = await setupComputer(runtime, paths, undefined, { replaceComputer: config.computer_id });
        expect(stale.code).toBe(1);
        expect(stale.events.at(-1)).toMatchObject({
            error: { code: "COMPUTER_REPLACEMENT_REQUIRED", replacement: { computerId: current.computer_id } },
        });
    });
});

test("Given an approved replacement request times out, When setup is retried without approval, Then it reports the uncertain access state and does not silently replace the Computer", {
    timeout: 120_000,
}, async () => {
    await withSetupComputer(async (runtime, paths) => {
        const first = await setupComputer(runtime, paths);
        expect(first.code).toBe(0);
        const config = await savedIdentity(paths.state);
        await runtime.forgetConnections();
        const uncertain = await setupComputer(runtime, paths, undefined, {
            replaceComputer: config.computer_id,
            stallFromStage: "replacement",
        });
        expect(uncertain.code).toBe(1);
        expect(uncertain.events.at(-1)).toMatchObject({
            error: { replacementAccess: { kind: "unknown", previousComputerId: config.computer_id } },
        });
        const retry = await setupComputer(runtime, paths);
        expect(retry.events.at(-1)).toMatchObject({
            error: {
                code: "COMPUTER_REPLACEMENT_REQUIRED",
                replacementAccess: { kind: "unknown", previousComputerId: config.computer_id },
            },
        });
        const finished = await setupComputer(runtime, paths, undefined, { replaceComputer: config.computer_id });
        expect(finished.code, JSON.stringify(finished.events)).toBe(0);
    });
});

test("Given a saved uncertain replacement and a restored local pairing, When setup runs without approval, Then it does not hide the uncertain access state behind a successful reconnection", {
    timeout: 120_000,
}, async () => {
    await withSetupComputer(async (runtime, paths) => {
        expect((await setupComputer(runtime, paths)).code).toBe(0);
        const configPath = join(paths.state, "config.json");
        const config = v.parse(
            v.looseObject({ identity: v.record(v.string(), v.unknown()) }),
            JSON.parse(await readFile(configPath, "utf8")),
        );
        const computerId = v.parse(v.string(), config.identity["computer_id"]);
        // A previous run recorded its intent, but was interrupted before it could record the response.
        await writeFile(
            configPath,
            JSON.stringify({ ...config, identity: { ...config.identity, replacement: { kind: "unknown" } } }),
            { mode: 0o600 },
        );
        const blocked = await setupComputer(runtime, paths);
        expect(blocked.code).toBe(1);
        expect(blocked.events.at(-1)).toMatchObject({
            error: {
                code: "COMPUTER_REPLACEMENT_REQUIRED",
                replacement: { computerId, reason: "replacement_result_unknown" },
                replacementAccess: { kind: "unknown" },
            },
        });
        expect(blocked.events).not.toContainEqual(expect.objectContaining({ status: "ready" }));
        expect((await setupComputer(runtime, paths, undefined, { replaceComputer: computerId })).code).toBe(0);
    });
});

test.each(["replacement_access_revoked", "computer_replaced"])(
    "Given an approved replacement was stopped at %s, When the user retries with the same approval, Then both the failure and the finished setup report that earlier access was revoked",
    {
        timeout: 120_000,
    },
    async (interruptAt) => {
        await withSetupComputer(async (runtime, paths) => {
            const first = await setupComputer(runtime, paths);
            expect(first.events.at(-1)).toMatchObject({ status: "ready", computer: "created" });
            const config = await savedIdentity(paths.state);
            await runtime.forgetConnections();

            const stopped = await setupComputer(runtime, paths, undefined, {
                replaceComputer: config.computer_id,
                interruptAt,
            });
            expect(stopped.code, JSON.stringify(stopped.events)).not.toBe(0);
            expect(stopped.events).not.toContainEqual(expect.objectContaining({ status: "ready" }));
            expect(stopped.events.at(-1)).toMatchObject({
                error: {
                    replacementAccess: { kind: "revoked", previousComputerId: config.computer_id, setupReady: false },
                },
            });

            const saved = await savedIdentity(paths.state);
            if (interruptAt === "replacement_access_revoked") {
                expect(saved).toMatchObject({ computer_id: config.computer_id, replacement: { kind: "unknown" } });
            } else {
                expect(saved.computer_id).not.toBe(config.computer_id);
                expect(saved.replacement).toEqual({
                    kind: "revoked",
                    previous: {
                        kind: "pending",
                        computer_id: config.computer_id,
                        computer_token: config.computer_token,
                    },
                });
            }

            const finished = await setupComputer(runtime, paths, undefined, { replaceComputer: config.computer_id });
            expect(finished.code, JSON.stringify(finished.events)).toBe(0);
            expect(finished.events.at(-1)).toMatchObject({ status: "ready", computer: "replaced" });

            const again = await setupComputer(runtime, paths);
            expect(again.events.at(-1)).toMatchObject({ status: "ready", computer: "reused" });
            expect((await savedIdentity(paths.state)).replacement).toEqual({ kind: "unchanged" });
        });
    },
);

test("Given a Computer bound by setup, When the user runs setup again, Then setup finishes on that Computer without a local binding copy", {
    timeout: 90_000,
}, async () => {
    await withSetupComputer(async (runtime, paths) => {
        const first = await setupComputer(runtime, paths);
        expect(first.code, JSON.stringify(first.events)).toBe(0);
        // The Worker's binding is the only record, so a reply lost after the Worker bound the Computer leaves the
        // local configuration exactly as a completed run does.
        const saved = v.parse(
            v.object({ identity: v.record(v.string(), v.unknown()) }),
            JSON.parse(await readFile(join(paths.state, "config.json"), "utf8")),
        );
        expect(saved.identity).toMatchObject({ pairing: { kind: "none" } });
        expect(saved.identity).not.toHaveProperty("agent_ref");

        const rerun = await setupComputer(runtime, paths);
        expect(rerun.code, JSON.stringify(rerun.events)).toBe(0);
        expect(rerun.events).toContainEqual(expect.objectContaining({ status: "computer_reused" }));
        expect(rerun.events.at(-1)).toMatchObject({ status: "ready", workspace: paths.workspace });
    });
});

test("Given two shared links and redeemed access, When the local owner revokes all access, Then previous links and credentials, the local credential included, fail while the replacement setup saved and another computer remain usable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-revoke-access-"));
    const configurationDirectory = join(directory, "state");
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    const fixture = await createIdentityFixture();
    const signal = AbortSignal.timeout(30000);
    try {
        const owner = await fixture.createAnonymousUser();
        const other = await fixture.createAnonymousUser();
        const configuration = savedSetupState(fixture.origin, owner);
        await writeFile(join(configurationDirectory, "config.json"), configuration, { mode: 0o600 });
        const request = (computerId: string, path: string, token: string, method = "GET", body?: object) =>
            fetch(`${fixture.origin}/morty/api/v1/computers/${computerId}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal,
            });
        const share = async (computerId: string, token: string) => {
            const response = await request(computerId, "/identity/transfers", token, "POST", {
                operationId: crypto.randomUUID(),
            });
            expect(response.status).toBe(201);
            return v.parse(v.object({ url: v.string() }), await response.json()).url;
        };
        const redeem = (url: string) =>
            worker.fetch(
                new Request(`${fixture.origin}/morty/api/v1/identity/transfers/redeem`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ code: new URL(url).hash.slice("#code=".length) }),
                    signal,
                }),
                fixture.environment(fixture.origin),
            );
        const links = [await share(owner.computerId, owner.token), await share(owner.computerId, owner.token)];
        const tokens: string[] = [];
        for (const link of links) {
            const response = await redeem(link);
            expect(response.status).toBe(200);
            tokens.push(v.parse(v.object({ computerToken: v.string() }), await response.json()).computerToken);
        }
        const remote = v.parse(v.string(), tokens[0]);
        for (const token of [remote]) {
            const refused = await fetch(
                `${fixture.origin}/morty/api/v1/computers/${owner.computerId}/identity/revoke-all-access`,
                {
                    method: "POST",
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    body: JSON.stringify({ successor: `morty_computer_v1_${"A".repeat(43)}` }),
                    signal,
                },
            );
            expect(refused.status).toBe(403);
        }
        const otherLink = await share(other.computerId, other.token);
        const mismatchEvents: Readonly<Record<string, unknown>>[] = [];
        expect(
            await runSetup(["revoke-all-access", "--base-url", "http://127.0.0.1:1"], {
                state: configurationDirectory,
                signal,
                emit: (event) => mismatchEvents.push(event),
            }),
        ).toBe(1);
        expect(mismatchEvents.at(-1)).toMatchObject({
            error: {
                code: "SAVED_IDENTITY_ORIGIN_MISMATCH",
                savedIdentity: { savedBaseUrl: fixture.origin, requestedBaseUrl: "http://127.0.0.1:1" },
            },
        });
        const events: Readonly<Record<string, unknown>>[] = [];
        expect(
            await runSetup(["revoke-all-access"], {
                state: configurationDirectory,
                signal,
                emit: (event) => events.push(event),
            }),
        ).toBe(0);
        expect(events.at(-1)).toMatchObject({ status: "access_revoked", computerId: owner.computerId });
        const successor = (await savedIdentity(configurationDirectory)).computer_token;
        expect(JSON.stringify(events)).not.toContain(owner.token);
        expect(JSON.stringify(events)).not.toContain(successor);
        for (const link of links) {
            expect((await redeem(link)).status).toBe(410);
        }
        for (const token of [...tokens, owner.token]) {
            expect((await request(owner.computerId, "/session", token)).status).toBe(401);
            expect(
                (
                    await request(owner.computerId, "/identity/transfers", token, "POST", {
                        operationId: crypto.randomUUID(),
                    })
                ).status,
            ).toBe(401);
        }
        expect(JSON.parse(await readFile(join(configurationDirectory, "config.json"), "utf8"))).toEqual(
            JSON.parse(savedSetupState(fixture.origin, { ...owner, token: successor })),
        );
        expect((await request(owner.computerId, "/session", successor)).status).toBe(200);
        expect((await redeem(otherLink)).status).toBe(200);
        expect(
            await runSetup(["revoke-all-access", "--base-url", fixture.origin], {
                state: configurationDirectory,
                signal,
                emit: () => undefined,
            }),
        ).toBe(0);
        const replacedAgain = (await savedIdentity(configurationDirectory)).computer_token;
        expect((await request(owner.computerId, "/session", successor)).status).toBe(401);
        expect((await redeem(await share(owner.computerId, replacedAgain))).status).toBe(200);
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);

test("Given setup replaced the Computer but stopped before ending the previous identity, When the user revokes all access, Then nothing opens the previous Project and only the replacement of the current identity setup saved opens the current one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-replaced-identity-"));
    const configurationDirectory = join(directory, "state");
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    const fixture = await createIdentityFixture();
    const signal = AbortSignal.timeout(30000);
    try {
        const previous = await fixture.createAnonymousUser();
        const request = (computerId: string, path: string, token: string, method = "GET", body?: object) =>
            fetch(`${fixture.origin}/morty/api/v1/computers/${computerId}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal,
            });
        const replaced = await request(previous.computerId, "/replacement", previous.token, "POST");
        expect(replaced.status).toBe(201);
        const current = v.parse(
            v.pipe(
                v.object({ computerId: v.string(), computerToken: v.string() }),
                v.transform(({ computerId, computerToken }) => ({ computerId, token: computerToken })),
            ),
            await replaced.json(),
        );
        // What setup saved before it stopped: the successor's identity, with the previous one still to end.
        await writeFile(
            join(configurationDirectory, "config.json"),
            savedSetupState(fixture.origin, current, {
                kind: "revoked",
                previous: { kind: "pending", computer_id: previous.computerId, computer_token: previous.token },
            }),
            { mode: 0o600 },
        );
        expect((await request(previous.computerId, "/session", previous.token)).status).toBe(200);

        const events: Readonly<Record<string, unknown>>[] = [];
        const code = await runSetup(["revoke-all-access"], {
            state: configurationDirectory,
            signal,
            emit: (event) => events.push(event),
        });
        expect(code, JSON.stringify(events)).toBe(0);

        expect(events.at(-1)).toMatchObject({ status: "access_revoked", computerId: current.computerId });
        expect(JSON.stringify(events)).not.toContain(previous.token);
        expect((await request(previous.computerId, "/session", previous.token)).status).toBe(401);
        expect(
            (
                await request(previous.computerId, "/identity/transfers", previous.token, "POST", {
                    operationId: crypto.randomUUID(),
                })
            ).status,
        ).toBe(401);
        const successor = (await savedIdentity(configurationDirectory)).computer_token;
        expect((await request(current.computerId, "/session", current.token)).status).toBe(401);
        expect((await request(current.computerId, "/session", successor)).status).toBe(200);
        expect(JSON.parse(await readFile(join(configurationDirectory, "config.json"), "utf8"))).toEqual(
            JSON.parse(
                savedSetupState(
                    fixture.origin,
                    { ...current, token: successor },
                    {
                        kind: "revoked",
                        previous: { kind: "retired", computer_id: previous.computerId },
                    },
                ),
            ),
        );
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);

test("Given the reply to revoking all access was lost after the Worker replaced the local credential, When the user revokes all access again, Then setup keeps the successor it saved and the earlier credential stays revoked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-revoke-access-retry-"));
    const configurationDirectory = join(directory, "state");
    await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
    const fixture = await createIdentityFixture();
    const signal = AbortSignal.timeout(30000);
    try {
        const owner = await fixture.createAnonymousUser();
        const successor = `morty_computer_v1_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
        // What setup saved before the request whose reply was lost.
        const saved = JSON.parse(savedSetupState(fixture.origin, owner));
        saved.identity.credential_rotation = { successor_token: successor };
        await writeFile(join(configurationDirectory, "config.json"), JSON.stringify(saved), { mode: 0o600 });
        const session = (token: string) =>
            fetch(`${fixture.origin}/morty/api/v1/computers/${owner.computerId}/session`, {
                headers: { authorization: `Bearer ${token}` },
                signal,
            });
        const lost = await fetch(
            `${fixture.origin}/morty/api/v1/computers/${owner.computerId}/identity/revoke-all-access`,
            {
                method: "POST",
                headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
                body: JSON.stringify({ successor }),
                signal,
            },
        );
        expect(lost.status).toBe(200);
        expect((await session(owner.token)).status).toBe(401);

        const events: Readonly<Record<string, unknown>>[] = [];
        const code = await runSetup(["revoke-all-access"], {
            state: configurationDirectory,
            signal,
            emit: (event) => events.push(event),
        });
        expect(code, JSON.stringify(events)).toBe(0);

        expect(events.at(-1)).toMatchObject({ status: "access_revoked", computerId: owner.computerId });
        expect(JSON.parse(await readFile(join(configurationDirectory, "config.json"), "utf8"))).toEqual(
            JSON.parse(savedSetupState(fixture.origin, { ...owner, token: successor })),
        );
        expect((await session(successor)).status).toBe(200);
        expect((await session(owner.token)).status).toBe(401);
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);
