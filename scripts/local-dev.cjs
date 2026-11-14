#!/usr/bin/env node
"use strict";

// Local full-stack development helper for Morty.
//
// Dependency-free CommonJS. Requires the repository's pinned Node.js (>= 24).
//
//   node scripts/local-dev.cjs prepare [options]
//   node scripts/local-dev.cjs setup  --state-dir <dir> --harness <id> --session-id <id> [options]
//   node scripts/local-dev.cjs status  --state-dir <dir>
//   node scripts/local-dev.cjs reload web --state-dir <dir>
//   node scripts/local-dev.cjs logs    --state-dir <dir> [options]
//   node scripts/local-dev.cjs remove  --state-dir <dir> [options]
//
// `prepare` starts one isolated Morty Worker serving the website and Relay,
// then prints a single JSON descriptor on stdout. All
// human-readable progress goes to stderr so stdout stays machine-parseable.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const { stripVTControlCharacters } = require("node:util");
const hostPlatform = require("./platform/index.cjs");

const REPO_ROOT = path.resolve(__dirname, "..");
const WRANGLER = path.join(REPO_ROOT, "node_modules", ".bin", "wrangler");
const CHAT_CONFIG = "packages/e2e/fixtures/wrangler.chat.jsonc";
const MORTY_LOCKFILE = path.join(REPO_ROOT, "pnpm-lock.yaml");
const MORTY_INSTALLED_LOCKFILE = path.join(REPO_ROOT, "node_modules", ".pnpm", "lock.yaml");
/** Fixed non-production Session signing secret, matching the e2e local stack. */
const LOCAL_SESSION_SIGNING_SECRET = "local-development-only-session-signing-secret";
/** An identifier the CLI and Relay accept for a harness or native session. */
const HARNESS_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

async function availablePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
                server.close(() => reject(new Error("Could not allocate a local port")));
                return;
            }
            const port = address.port;
            server.close((error) => (error === undefined ? resolve(port) : reject(error)));
        });
    });
}

function log(message) {
    process.stderr.write(`[local-dev] ${message}\n`);
}

function fail(message) {
    log(`ERROR ${message}`);
    process.exit(1);
}

function parseArguments(argv) {
    const options = { command: argv[0] ?? "help", mode: argv[1] ?? "web-server" };
    const requireValue = (index, token) => {
        const value = argv[index + 1];
        if (value === undefined || value.length === 0) {
            fail(`${token} requires a value`);
        }
        return value;
    };
    for (let index = 1; index < argv.length; index += 1) {
        const token = argv[index];
        if (index === 1 && !token.startsWith("--")) {
            options.mode = token;
            continue;
        }
        switch (token) {
            case "--state-dir":
                options.stateDir = path.resolve(requireValue(index, token));
                index += 1;
                break;
            case "--chat-port":
                options.chatPort = Number.parseInt(requireValue(index, token), 10);
                index += 1;
                break;
            case "--worker":
                options.worker = requireValue(index, token);
                index += 1;
                break;
            case "--harness":
                options.harness = requireValue(index, token);
                index += 1;
                break;
            case "--session-id":
                options.sessionId = requireValue(index, token);
                index += 1;
                break;
            case "--workspace":
                options.workspace = requireValue(index, token);
                index += 1;
                break;
            case "--lines":
                options.lines = Number.parseInt(requireValue(index, token), 10);
                index += 1;
                break;
            case "--filter":
                options.filter = requireValue(index, token);
                index += 1;
                break;
            case "--follow":
                options.follow = true;
                break;
            case "--force":
                options.force = true;
                break;
            case "--no-build":
                options.build = false;
                break;
            case "--keep-state":
                options.keepState = true;
                break;
            case "--background":
                options.background = true;
                break;
            default:
                break;
        }
    }
    return options;
}

async function localLaunch(command, args) {
    const { executableLaunch, findExecutableOnPath, resolveExecutablePath } = await import(
        pathToFileURL(path.join(REPO_ROOT, "packages/cli/src/engine/util/process/executable.ts")).href
    );
    const executable = path.isAbsolute(command)
        ? await resolveExecutablePath(command)
        : await findExecutableOnPath(command, process.env);
    if (executable === null) {
        throw new Error(`A supported executable is required: ${command}`);
    }
    return executableLaunch(executable.path, args);
}

async function run(command, args, options = {}) {
    // Every caller owns CLI cancellation before resolving or spawning a detached
    // command, including prepare's migrations, dependency installation and build.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const signal =
        options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
        return await runOwnedCommand(command, args, { ...options, signal });
    } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
    }
}

async function runOwnedCommand(command, args, options) {
    options.signal?.throwIfAborted();
    const launch = await localLaunch(command, args);
    const { stopProcessTree, spawnProcess, platformSpawnOptions, ProcessExecutionError } = await import(
        pathToFileURL(path.join(REPO_ROOT, "packages/cli/src/engine/util/process/executable.ts")).href
    );
    options.signal?.throwIfAborted();
    const environment = { ...process.env, ...options.env };
    const child = spawnProcess(launch.command, launch.arguments, {
        ...platformSpawnOptions,
        cwd: options.cwd ?? REPO_ROOT,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const completion = new Promise((resolve, reject) => {
        child.once("error", reject);
        // Drain both pipes before formatting a failed command's diagnostic tail.
        child.once("close", (code, signal) =>
            code === 0
                ? resolve()
                : reject(new ProcessExecutionError("process_exit_failed", `exited ${code ?? signal}`)),
        );
    });
    const interrupted = Promise.withResolvers();
    let cleanup;
    const interrupt = (failure) => {
        if (cleanup !== undefined) {
            return;
        }
        // Use the production operating system adapters to own and reap the entire tree.
        // Resolve the interruption only after graceful/forced termination completes.
        cleanup = stopProcessTree(child).then(
            () => failure,
            (cause) =>
                new ProcessExecutionError("process_termination_failed", "command tree cleanup failed", { cause }),
        );
        void cleanup.then(interrupted.reject);
    };
    const output = { stdout: [], stderr: [] };
    const bytes = { stdout: 0, stderr: 0 };
    const limit = 16 * 1024 * 1024;
    const collect = (stream, chunk) => {
        if (cleanup !== undefined) {
            return;
        }
        output[stream].push(chunk.subarray(0, Math.max(0, limit - bytes[stream])));
        bytes[stream] += chunk.length;
        if (bytes[stream] > limit) {
            interrupt(new ProcessExecutionError("process_output_limit", "command output exceeded 16 MiB"));
        }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    const timeout = setTimeout(
        () => interrupt(new ProcessExecutionError("process_timeout", "command timed out")),
        options.timeout ?? 300_000,
    );
    const abort = () =>
        interrupt(
            new ProcessExecutionError("process_cancelled", "command was cancelled", { cause: options.signal.reason }),
        );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
        abort();
    }
    const stdout = () => Buffer.concat(output.stdout).toString("utf8");
    const stderr = () => Buffer.concat(output.stderr).toString("utf8");
    try {
        await Promise.race([completion, interrupted.promise]);
        if (cleanup !== undefined) {
            await interrupted.promise;
        }
        return { stdout: stdout(), stderr: stderr() };
    } catch (cause) {
        const original = cleanup === undefined ? cause : await cleanup;
        const failure =
            original instanceof ProcessExecutionError
                ? original
                : new ProcessExecutionError("process_spawn_failed", "command could not be started", {
                      cause: original,
                  });
        // Never print raw arguments: --var and setup arguments can contain credentials.
        const label = `${path.basename(command)}${/^[a-z][a-z:-]*$/u.test(args[0] ?? "") ? ` ${args[0]}` : ""}`;
        const tail = sanitizeCommandOutput(stderr() || stdout(), environment, args).slice(-8_000);
        throw new ProcessExecutionError(
            failure.code,
            `${label}: ${failure.message}${tail.length === 0 ? "" : `\n${tail}`}`,
            { cause: failure },
        );
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        if (cleanup !== undefined) {
            await cleanup;
        } else {
            await stopProcessTree(child);
        }
    }
}

function sanitizeCommandOutput(output, environment, args) {
    const sensitive = /secret|token|password|credential|authorization|private.?key|encryption.?key/iu;
    const values = Object.entries(environment)
        .filter(([key, value]) => sensitive.test(key) && typeof value === "string" && value.length > 0)
        .map(([, value]) => value);
    // Also cover credentials supplied as CLI flags or Wrangler KEY:value bindings.
    for (const tokens of [args, process.argv.slice(2)]) {
        for (let index = 0; index < tokens.length; index += 1) {
            const match = /^([^:=]+)[:=](.*)$/u.exec(tokens[index]);
            if (match !== null && sensitive.test(match[1]) && match[2].length > 0) {
                values.push(match[2]);
            } else if (tokens[index].startsWith("--") && sensitive.test(tokens[index]) && tokens[index + 1]) {
                values.push(tokens[index + 1]);
            }
        }
    }
    // Color sequences can split a credential between individual characters.
    let sanitized = stripVTControlCharacters(output);
    const secrets = [...new Set(values.map(stripVTControlCharacters).filter((value) => value.length > 0))]
        .sort((left, right) => right.length - left.length)
        .map((value) => RegExp.escape(value));
    if (secrets.length > 0) {
        sanitized = sanitized.replace(new RegExp(secrets.join("|"), "gu"), "[REDACTED]");
    }
    return sanitized.replace(/Bearer\s+[^\s"']+/giu, "Bearer [REDACTED]");
}

async function startProcess(name, args, logPath, command = WRANGLER, env = {}, cwd = REPO_ROOT) {
    const launch = await localLaunch(command, args);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const output = fs.openSync(logPath, "a", 0o600);
    const child = spawn(launch.command, launch.arguments, {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", output, output],
    });
    child.unref();
    fs.closeSync(output);
    if (child.pid === undefined) {
        throw new Error(`Could not start ${name}`);
    }
    log(`started ${name} pid=${child.pid}`);
    return child.pid;
}

function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function stopProcess(pid) {
    await hostPlatform.stopProcess(pid);
}

async function waitForHttp(url, accept, timeoutMilliseconds, description, process, signal) {
    const deadline = Date.now() + timeoutMilliseconds;
    let last = "no attempt";
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (process !== undefined && !isAlive(process.pid)) {
            throw new Error(`${description} process exited before becoming healthy; see ${process.logPath}`);
        }
        try {
            const timeout = AbortSignal.timeout(3_000);
            const response = await fetch(url, {
                signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            });
            if (await accept(response)) {
                return;
            }
            last = `status ${response.status}`;
        } catch (error) {
            signal?.throwIfAborted();
            last = error instanceof Error ? error.message : String(error);
        }
        await delay(400, undefined, { signal });
    }
    throw new Error(`Timed out waiting for ${description}: ${last}`);
}

async function ensureMortyDependencies() {
    const installed =
        fs.existsSync(MORTY_INSTALLED_LOCKFILE) &&
        fs.readFileSync(MORTY_LOCKFILE).equals(fs.readFileSync(MORTY_INSTALLED_LOCKFILE));
    if (!installed) {
        log("installing Morty workspace dependencies from the lockfile");
        await run("pnpm", ["install", "--frozen-lockfile"], { cwd: REPO_ROOT });
    }
}

function readStack(stateDir) {
    const file = path.join(stateDir, "stack.json");
    if (!fs.existsSync(file)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeStack(stack) {
    fs.writeFileSync(path.join(stack.stateDir, "stack.json"), `${JSON.stringify(stack, null, 2)}\n`, {
        mode: 0o600,
    });
}

async function keepAlive(stack, options) {
    if (options.background === true) {
        return;
    }
    await new Promise((resolve) => {
        const shutdown = async () => {
            await stopRecorded(stack);
            resolve();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    });
}

async function prepare(options) {
    const validModes = new Set(["web-server", "web-server-morty-cli"]);
    if (!validModes.has(options.mode)) {
        throw new Error(`Unknown mode ${options.mode}; use web-server or web-server-morty-cli`);
    }
    const chatPort = options.chatPort ?? (await availablePort());
    const stateDir = options.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "chat-local-full-dev-"));
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const existing = readStack(stateDir);
    if (existing !== null) {
        if (options.force !== true && isAlive(existing.chatPid)) {
            log(`reusing live stack at ${stateDir}`);
            process.stdout.write(`${JSON.stringify(existing)}\n`);
            return;
        }
        log(`stopping existing stack at ${stateDir}`);
        await stopRecorded(existing);
    }

    const chatPersist = path.join(stateDir, "chat");
    const chatLog = path.join(stateDir, "chat.log");
    const chatOrigin = `http://localhost:${chatPort}`;
    let stack = {
        mode: options.mode,
        chatLog,
        chatOrigin,
        chatPersist,
        ready: false,
        stateDir,
    };
    writeStack(stack);

    try {
        await ensureMortyDependencies();
        if (options.build !== false) {
            log("building Chat Worker");
            await run("pnpm", ["build"]);
        }
        const variables = {
            APP_ORIGIN: chatOrigin,
            MORTY_SESSION_SIGNING_SECRET: LOCAL_SESSION_SIGNING_SECRET,
        };
        const variableArguments = Object.entries(variables).flatMap(([key, value]) => ["--var", `${key}:${value}`]);

        log("starting Chat Worker");
        const chatPid = await startProcess(
            "chat",
            [
                "dev",
                "--config",
                CHAT_CONFIG,
                "--ip",
                "127.0.0.1",
                "--port",
                String(chatPort),
                "--inspector-port",
                "0",
                "--persist-to",
                chatPersist,
                ...variableArguments,
            ],
            chatLog,
        );
        stack = { ...stack, chatPid };
        writeStack(stack);
        await waitForHttp(chatOrigin, (response) => response.ok, 90_000, "Chat Worker", {
            pid: chatPid,
            logPath: chatLog,
        });

        let cliLog;
        if (options.mode === "web-server-morty-cli") {
            cliLog = path.join(stateDir, "cli.log");
            log("checking local Morty CLI");
            await run("pnpm", ["--filter", "@morty-build/cli", "start", "agents"], {
                cwd: REPO_ROOT,
                env: { MORTY_STATE_DIRECTORY: path.join(stateDir, "morty") },
            }).then(({ stdout, stderr }) => fs.writeFileSync(cliLog, `${stdout}${stderr}`, { mode: 0o600 }));
        }

        stack = {
            ...stack,
            mode: options.mode,
            cliCommand:
                options.mode === "web-server-morty-cli" ? "pnpm --filter @morty-build/cli start agents" : undefined,
            ...(cliLog === undefined ? {} : { cliLog }),
            chatConfig: CHAT_CONFIG,
            chatLog,
            chatOrigin,
            chatPersist,
            chatPid,
            ready: true,
            stateDir,
        };
        writeStack(stack);
        log(`ready at ${chatOrigin}`);
        process.stdout.write(`${JSON.stringify(stack)}\n`);
        await keepAlive(stack, options);
    } catch (error) {
        await stopRecorded(stack);
        writeStack({ ...stack, ready: false });
        throw error;
    }
}

const SETUP_READY_TIMEOUT_MILLISECONDS = 300_000;

async function installLocalCli(stack) {
    const cliDirectory = path.join(REPO_ROOT, "packages/cli");
    const manifest = JSON.parse(fs.readFileSync(path.join(cliDirectory, "package.json"), "utf8"));
    if (
        manifest.name !== "@morty-build/cli" ||
        typeof manifest.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(manifest.version)
    ) {
        fail("the checkout's CLI package must have a valid Morty name and version");
    }
    const packageDirectory = fs.mkdtempSync(path.join(stack.stateDir, "cli-package-"));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const options = {
        signal: controller.signal,
        timeout: SETUP_READY_TIMEOUT_MILLISECONDS,
    };
    try {
        log(`building and packing the checkout's Morty CLI ${manifest.version}`);
        await run("pnpm", ["pack", "--pack-destination", packageDirectory], { ...options, cwd: cliDirectory });
        controller.signal.throwIfAborted();
        const tarball = path.join(packageDirectory, `morty-build-cli-${manifest.version}.tgz`);
        const prefix = path.join(stack.stateDir, "local-cli", manifest.version);
        log(`installing the local CLI into ${prefix}`);
        await run(
            "npm",
            [
                "install",
                "--prefix",
                prefix,
                "--ignore-scripts",
                "--omit=dev",
                "--no-audit",
                "--no-fund",
                "--save-exact",
                "--",
                tarball,
            ],
            options,
        );
        controller.signal.throwIfAborted();
        const entry = path.join(prefix, "node_modules", "@morty-build", "cli", "dist", "cli.js");
        return entry;
    } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
        fs.rmSync(packageDirectory, { recursive: true, force: true });
    }
}

function readSetupRecord(line) {
    if (line.length === 0) {
        return null;
    }
    try {
        const value = JSON.parse(line);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            return value;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Runs the installed CLI's `setup` flow with Morty's writable
 * location isolated under the stack's state directory. `morty/` isolates
 * Morty's saved setup state, CLI manager and connection
 * state, and `workspace/` is the default working directory. On success prints
 * one JSON record whose `handoffUrl` continues the setup identity in the
 * browser.
 */
async function setup(options) {
    if (options.harness === undefined) {
        fail("--harness is required; pass the selected harness identifier, for example codex or claude");
    }
    if (!HARNESS_IDENTIFIER_PATTERN.test(options.harness)) {
        fail("--harness must be a harness identifier");
    }
    const harness = options.harness;
    if (options.sessionId === undefined) {
        fail("--session-id is required; pass the selected harness's exact current session identifier");
    }
    if (!HARNESS_IDENTIFIER_PATTERN.test(options.sessionId)) {
        fail("--session-id must be a harness session identifier");
    }
    const sessionId = options.sessionId;
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        fail("pass --state-dir for a stack created by prepare");
    }
    if (!isAlive(stack.chatPid)) {
        fail("the stack's Chat Worker is not running; run prepare first");
    }
    const mortyStateDirectory = path.join(stack.stateDir, "morty");
    const runtimeStateDirectory = mortyStateDirectory;
    const workspace = path.resolve(options.workspace ?? path.join(stack.stateDir, "workspace"));
    for (const directory of [mortyStateDirectory, workspace]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const localCli = await installLocalCli(stack);
    const origin = new URL(stack.chatOrigin).origin;

    const setupLog = path.join(stack.stateDir, "setup.log");
    fs.writeFileSync(setupLog, "", { mode: 0o600 });
    log(`running setup for harness "${harness}" against workspace ${workspace}`);
    const runtimePid = await startProcess(
        "setup runtime",
        [localCli, "setup", "--base-url", origin, "--cwd", workspace, "--harness", harness, "--session-id", sessionId],
        setupLog,
        process.execPath,
        {
            MORTY_STATE_DIRECTORY: mortyStateDirectory,
        },
        workspace,
    );

    const deadline = Date.now() + SETUP_READY_TIMEOUT_MILLISECONDS;
    let ready = null;
    let computerId = null;
    for (;;) {
        const records = fs
            .readFileSync(setupLog, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map(readSetupRecord);
        const failure = records.findLast((record) => record !== null && record.error !== undefined);
        if (failure !== undefined && failure !== null) {
            await stopProcess(runtimePid);
            fail(`setup failed: ${JSON.stringify(failure.error)}`);
        }
        const reused = records.findLast((record) => record !== null && record.status === "computer_reused");
        if (reused !== undefined && reused !== null && typeof reused.computerId === "string") {
            computerId = reused.computerId;
        }
        const paired = records.findLast((record) => record !== null && record.status === "computer_paired");
        if (paired !== undefined && paired !== null && typeof paired.computerId === "string") {
            computerId = paired.computerId;
        }
        const completed = records.findLast((record) => record !== null && record.status === "ready");
        if (completed !== undefined && completed !== null) {
            ready = completed;
            break;
        }
        if (Date.now() > deadline || !isAlive(runtimePid)) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (ready === null) {
        await stopProcess(runtimePid);
        fail(
            `the setup runtime did not report ready within ${SETUP_READY_TIMEOUT_MILLISECONDS / 1000}s; see ${setupLog}`,
        );
    }
    if (computerId === null) {
        fail("the setup runtime did not report its Computer ID");
    }
    const handoffUrl = typeof ready.url === "string" ? ready.url : "";
    if (handoffUrl.length === 0) {
        fail("the setup runtime did not return a handoff URL");
    }

    const record = {
        chatOrigin: stack.chatOrigin,
        computerId,
        handoffUrl,
        mortyStateDirectory,
        harness,
        runtimeStateDirectory,
        runtimePid,
        sessionId,
        setupLog,
        workspace,
    };
    const previous = Array.isArray(stack.runtimes) ? stack.runtimes : [];
    writeStack({ ...stack, runtimes: [...previous, record] });
    process.stdout.write(`${JSON.stringify(record)}\n`);
    log("setup is ready; open handoffUrl in the browser to continue as this user");
}

async function reload(options) {
    const target = options.mode;
    if (target !== "web" && target !== "chat") {
        throw new Error("reload requires a target: web (or chat)");
    }
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        throw new Error("pass --state-dir for a stack created by prepare");
    }
    if (!["web-server", "web-server-morty-cli"].includes(stack.mode)) {
        throw new Error("unsupported stack mode; run prepare first");
    }
    const origin = new URL(stack.chatOrigin);
    if (origin.protocol !== "http:" || origin.hostname !== "localhost" || origin.origin !== stack.chatOrigin) {
        throw new Error("the stack must use a local Chat origin created by prepare");
    }
    const stateDir = fs.realpathSync(options.stateDir);
    const chatPersist = path.join(stateDir, "chat");
    if (fs.realpathSync(chatPersist) !== chatPersist) {
        throw new Error("Chat persistence must resolve inside the selected state directory");
    }
    if (!isAlive(stack.chatPid)) {
        throw new Error("the stack's web/Chat process is not running; run prepare first");
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const operation = { signal: controller.signal, timeout: SETUP_READY_TIMEOUT_MILLISECONDS };
    try {
        log("rebuilding web/Chat; Relay and paired computers will stay running");
        // Do not delete the entrypoint/assets while the live Wrangler watcher reads them.
        await run("pnpm", ["build", "--emptyOutDir", "false"], operation);
        controller.signal.throwIfAborted();
        await waitForHttp(
            stack.chatOrigin,
            (response) => response.ok,
            90_000,
            "reloaded web/Chat",
            { pid: stack.chatPid, logPath: stack.chatLog },
            controller.signal,
        );
        log(`web/Chat ready at ${stack.chatOrigin}; refresh the browser to load rebuilt assets`);
        process.stdout.write(`${JSON.stringify(stack)}\n`);
    } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
    }
}

async function status(options) {
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        fail("pass --state-dir for a stack created by prepare");
    }
    const chatAlive = isAlive(stack.chatPid);
    const runtimes = Array.isArray(stack.runtimes)
        ? stack.runtimes.map((runtime) => ({ ...runtime, alive: isAlive(runtime.runtimePid) }))
        : [];
    let chatHttp = false;
    try {
        chatHttp = (await fetch(stack.chatOrigin, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
        chatHttp = false;
    }
    process.stdout.write(`${JSON.stringify({ ...stack, chatAlive, chatHttp, runtimes }, null, 2)}\n`);
}

function readLines(file, count) {
    if (!fs.existsSync(file)) {
        return [];
    }
    return fs.readFileSync(file, "utf8").split("\n").slice(-count);
}

async function logs(options) {
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        fail("pass --state-dir for a stack created by prepare");
    }
    const worker = options.worker ?? "chat";
    const runtimeLogs = (Array.isArray(stack.runtimes) ? stack.runtimes : []).map((runtime) => runtime.setupLog);
    const uniqueRuntimeLogs = [...new Set(runtimeLogs.filter((file) => typeof file === "string"))];
    const files =
        worker === "all"
            ? [stack.chatLog, ...uniqueRuntimeLogs].filter((file) => file !== undefined)
            : worker === "runtime"
              ? uniqueRuntimeLogs
              : [stack.chatLog];
    const filter = options.filter === undefined ? null : new RegExp(options.filter, "u");
    const count = Number.isInteger(options.lines) ? options.lines : 200;
    const print = (file) => {
        for (const line of readLines(file, count)) {
            if (line.length === 0) {
                continue;
            }
            if (filter === null || filter.test(line)) {
                process.stdout.write(`${line}\n`);
            }
        }
    };
    for (const file of files) {
        print(file);
    }
    if (options.follow === true) {
        log(`following ${files.join(", ")}; press Ctrl+C to stop`);
        const offsets = new Map(files.map((file) => [file, fs.existsSync(file) ? fs.statSync(file).size : 0]));
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            for (const file of files) {
                if (!fs.existsSync(file)) {
                    continue;
                }
                const size = fs.statSync(file).size;
                const offset = offsets.get(file) ?? 0;
                if (size <= offset) {
                    if (size < offset) {
                        offsets.set(file, size);
                    }
                    continue;
                }
                const stream = fs.createReadStream(file, { start: offset, encoding: "utf8" });
                for await (const chunk of stream) {
                    for (const line of String(chunk).split("\n")) {
                        if (line.length > 0 && (filter === null || filter.test(line))) {
                            process.stdout.write(`${line}\n`);
                        }
                    }
                }
                offsets.set(file, size);
            }
        }
    }
}

async function stopRecorded(stack) {
    const runtimeStateDirectory = path.join(stack.stateDir, "morty");
    for (const runtime of Array.isArray(stack.runtimes) ? stack.runtimes : []) {
        await stopProcess(runtime.runtimePid);
    }
    if (fs.existsSync(runtimeStateDirectory)) {
        log(`stopping the Morty manager at ${runtimeStateDirectory}`);
        try {
            await run(process.execPath, [path.join(REPO_ROOT, "packages/cli/src/cli/entrypoint.ts"), "quit"], {
                env: { MORTY_STATE_DIRECTORY: runtimeStateDirectory },
            });
        } catch (cause) {
            log(`could not stop the Morty manager: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }
    if (stack.chatPid !== undefined) {
        log(`stopping Chat Worker (pid ${stack.chatPid})`);
        await stopProcess(stack.chatPid);
    }
    if (stack.webPid !== undefined) {
        await stopProcess(stack.webPid);
    }
}

async function remove(options) {
    const stack = options.stateDir === undefined ? null : readStack(options.stateDir);
    if (stack === null) {
        if (options.stateDir !== undefined && fs.existsSync(options.stateDir)) {
            log("no stack record found; deleting the state directory");
            if (options.keepState !== true) {
                fs.rmSync(options.stateDir, { recursive: true, force: true });
            }
            return;
        }
        fail("pass --state-dir for a stack created by prepare");
    }
    await stopRecorded(stack);
    if (options.keepState !== true) {
        log(`deleting ${stack.stateDir}`);
        fs.rmSync(stack.stateDir, { recursive: true, force: true });
    }
}

function usage(stream = process.stdout) {
    stream.write(
        [
            "Usage:",
            "  node scripts/local-dev.cjs prepare <web-server|web-server-morty-cli> [--state-dir DIR] [--chat-port N] [--force] [--no-build] [--background]",
            "  node scripts/local-dev.cjs setup  --state-dir DIR --harness ID --session-id ID [--workspace DIR]",
            "  node scripts/local-dev.cjs status --state-dir DIR",
            "  node scripts/local-dev.cjs reload <web|chat> --state-dir DIR",
            "  node scripts/local-dev.cjs logs   --state-dir DIR [--worker chat|runtime|all] [--lines N] [--filter REGEX] [--follow]",
            "  node scripts/local-dev.cjs remove --state-dir DIR [--keep-state]",
            "",
            "reload rebuilds web/Chat without restarting Relay or computers.",
            "",
        ].join("\n"),
    );
}

const COMMANDS = new Set(["prepare", "setup", "status", "reload", "logs", "remove"]);
const HELP_COMMANDS = new Set(["help", "--help", "-h"]);

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (HELP_COMMANDS.has(options.command)) {
        usage();
        return;
    }
    if (!COMMANDS.has(options.command)) {
        usage(process.stderr);
        fail(`unknown command "${options.command}"`);
    }
    switch (options.command) {
        case "prepare":
            await prepare(options);
            break;
        case "setup":
            await setup(options);
            break;
        case "status":
            await status(options);
            break;
        case "reload":
            await reload(options);
            break;
        case "logs":
            await logs(options);
            break;
        case "remove":
            await remove(options);
            break;
    }
}

main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
});
