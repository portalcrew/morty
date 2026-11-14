import { type ChildProcess, execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
    executableLaunch,
    findExecutableOnPath,
    resolveExecutablePath,
    spawnProcess,
    stopProcessTree,
} from "../../../packages/cli/src/engine/util/process/executable.ts";

interface ErrorRecord {
    readonly message: string;
    readonly name?: string;
    readonly cause?: ErrorRecord;
}
interface ProcessOptions {
    readonly env?: Readonly<Record<string, string>>;
}
interface ProcessRecord {
    readonly child: ChildProcess;
    readonly name: string;
    readonly logPath: string;
    readonly output: number;
}
type Stage = { readonly name: string; readonly startedAt: string } & (
    | { readonly status: "running" }
    | { readonly status: "passed"; readonly durationMilliseconds: number }
    | { readonly status: "failed"; readonly durationMilliseconds: number; readonly error: ErrorRecord }
);
type BrowserState =
    | { readonly kind: "none" }
    | {
          readonly kind: "recording" | "stopped";
          readonly browser: Browser;
          readonly context: BrowserContext;
          readonly page: Page;
      };

const execute = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function localLaunch(command: string, args: readonly string[]) {
    const executable = isAbsolute(command)
        ? await resolveExecutablePath(command)
        : await findExecutableOnPath(command, process.env);
    if (executable === null) {
        throw new Error(`A supported executable is required: ${command}`);
    }
    return executableLaunch(executable.path, args);
}

function errorRecord(error: unknown): ErrorRecord {
    if (!(error instanceof Error)) {
        return { message: String(error) };
    }
    return {
        message: error.message,
        name: error.name,
        ...(error.cause === undefined ? {} : { cause: errorRecord(error.cause) }),
    };
}

export class E2EHarness {
    readonly name: string;
    readonly rootDirectory: string;
    readonly artifactDirectory: string;
    readonly workDirectory: string;
    readonly preserveArtifacts: boolean;
    readonly timeoutMilliseconds: number;
    readonly signal: AbortSignal;
    readonly startedAt: number;
    readonly children: ProcessRecord[];
    readonly stages: Stage[];
    readonly browserEvents: unknown[];
    browserState: BrowserState = { kind: "none" };
    result:
        | { readonly kind: "running" }
        | { readonly kind: "finished"; readonly success: boolean; readonly finishedAt: number } = { kind: "running" };
    failure: ErrorRecord | undefined;

    get page() {
        return this.browserState.kind === "none" ? undefined : this.browserState.page;
    }

    static async create(name: string) {
        const configuredRoot = process.env["MORTY_E2E_ARTIFACT_ROOT"];
        const parent = configuredRoot === undefined ? tmpdir() : resolve(configuredRoot);
        await mkdir(parent, { recursive: true });
        const rootDirectory = await mkdtemp(join(parent, `${name}-`));
        const artifactDirectory = join(rootDirectory, "artifacts");
        const workDirectory = join(rootDirectory, "work");
        await Promise.all([artifactDirectory, workDirectory].map((path) => mkdir(path, { recursive: true })));
        return new E2EHarness(name, rootDirectory, artifactDirectory, workDirectory);
    }

    constructor(name: string, rootDirectory: string, artifactDirectory: string, workDirectory: string) {
        this.name = name;
        this.rootDirectory = rootDirectory;
        this.artifactDirectory = artifactDirectory;
        this.workDirectory = workDirectory;
        // MORTY_E2E_ARTIFACT_ROOT only places the diagnostics: a failure keeps them, a success keeps them on request.
        this.preserveArtifacts = process.env["MORTY_E2E_KEEP_STATE"] === "1";
        this.timeoutMilliseconds = Number(process.env["MORTY_E2E_TIMEOUT_MS"] ?? 10 * 60 * 1_000);
        this.signal = AbortSignal.timeout(this.timeoutMilliseconds);
        this.startedAt = Date.now();
        this.children = [];
        this.stages = [];
        this.browserEvents = [];
    }

    log(message: string) {
        process.stdout.write(`[${this.name}] ${message}\n`);
    }

    async stage<T>(name: string, action: () => Promise<T>): Promise<T> {
        const stage = { name, startedAt: new Date().toISOString() };
        const startedMilliseconds = Date.now();
        const index = this.stages.push({ ...stage, status: "running" }) - 1;
        this.log(`START ${name}`);
        try {
            const result = await action();
            this.stages[index] = { ...stage, status: "passed", durationMilliseconds: Date.now() - startedMilliseconds };
            return result;
        } catch (error) {
            this.stages[index] = {
                ...stage,
                status: "failed",
                error: errorRecord(error),
                durationMilliseconds: Date.now() - startedMilliseconds,
            };
            throw new Error(`[${name}] ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        } finally {
            this.log(
                `${this.stages[index]?.status === "passed" ? "PASS" : "FAIL"} ${name} (${Date.now() - startedMilliseconds}ms)`,
            );
            await this.#writeRunRecord();
        }
    }

    async run(command: string, args: readonly string[], options: ProcessOptions = {}) {
        this.log(`RUN ${command} ${args.join(" ")}`);
        const launch = await localLaunch(command, args);
        return await execute(launch.command, launch.arguments, {
            cwd: REPOSITORY_ROOT,
            env: { ...process.env, ...options.env },
            maxBuffer: 16 * 1024 * 1024,
            signal: this.signal,
            windowsHide: true,
        });
    }

    async startWorker(name: string, command: string, args: readonly string[]) {
        const launch = await localLaunch(command, args);
        const logPath = join(this.artifactDirectory, `${name}.log`);
        const output = openSync(logPath, "a", 0o600);
        const child = spawnProcess(launch.command, launch.arguments, {
            cwd: REPOSITORY_ROOT,
            detached: true,
            env: process.env,
            stdio: ["ignore", output, output, "ipc"],
            windowsHide: true,
        });
        const processRecord = { child, logPath, name, output };
        this.children.push(processRecord);
        const startupSignal = AbortSignal.any([this.signal, AbortSignal.timeout(90_000)]);
        await new Promise<void>((resolveReady, reject) => {
            const cleanup = () => {
                child.removeListener("message", ready);
                child.removeListener("error", failed);
                child.removeListener("exit", exited);
                startupSignal.removeEventListener("abort", aborted);
            };
            const failed = (cause: unknown) => {
                cleanup();
                reject(cause);
            };
            const exited = (code: number | null, signal: NodeJS.Signals | null) =>
                failed(new Error(`${name} exited before readiness (${code ?? signal})`));
            const aborted = () => failed(startupSignal.reason);
            const ready = (message: unknown) => {
                if (typeof message !== "string") {
                    return;
                }
                let value: unknown;
                try {
                    value = JSON.parse(message);
                } catch (cause) {
                    failed(new Error("Invalid Worker readiness message", { cause }));
                    return;
                }
                if (
                    typeof value === "object" &&
                    value !== null &&
                    "event" in value &&
                    value.event === "DEV_SERVER_READY"
                ) {
                    cleanup();
                    resolveReady();
                }
            };
            child.on("message", ready);
            child.once("error", failed);
            child.once("exit", exited);
            if (startupSignal.aborted) {
                aborted();
                return;
            }
            startupSignal.addEventListener("abort", aborted, { once: true });
        });
        this.log(`STARTED ${name} pid=${child.pid}`);
        return child;
    }

    async checkHttp(
        url: string,
        description: string,
        accept: (response: Response) => boolean | Promise<boolean> = (response) => response.ok,
    ) {
        await this.#assertProcessesRunning();
        const response = await fetch(url, { signal: AbortSignal.any([this.signal, AbortSignal.timeout(90_000)]) });
        if (!(await accept(response))) {
            throw new Error(`${description} is not healthy after Worker readiness (${response.status})`);
        }
        return response;
    }

    async attachBrowser(browser: Browser, context: BrowserContext, page: Page) {
        this.browserState = { kind: "stopped", browser, context, page };
        page.on("console", (message) =>
            this.browserEvents.push({ type: "console", level: message.type(), text: message.text() }),
        );
        page.on("pageerror", (error) => this.browserEvents.push({ type: "pageerror", ...errorRecord(error) }));
        page.on("requestfailed", (request) =>
            this.browserEvents.push({
                type: "requestfailed",
                method: request.method(),
                url: request.url(),
                failure: request.failure(),
            }),
        );
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        this.browserState = { kind: "recording", browser, context, page };
    }

    async diagnose(error: unknown) {
        this.failure = errorRecord(error);
        const captures: readonly (readonly [string, () => Promise<unknown> | undefined])[] = [
            [
                "browser-events.json",
                () =>
                    writeFile(
                        join(this.artifactDirectory, "browser-events.json"),
                        `${JSON.stringify(this.browserEvents, null, 2)}\n`,
                    ),
            ],
            [
                "page.html",
                () => this.page?.content().then((html) => writeFile(join(this.artifactDirectory, "page.html"), html)),
            ],
            [
                "page.png",
                () => this.page?.screenshot({ path: join(this.artifactDirectory, "page.png"), fullPage: true }),
            ],
            [
                "playwright-trace.zip",
                async () => {
                    if (this.browserState.kind === "recording") {
                        await this.browserState.context.tracing.stop({
                            path: join(this.artifactDirectory, "playwright-trace.zip"),
                        });
                        this.browserState = { ...this.browserState, kind: "stopped" };
                    }
                },
            ],
        ];
        for (const [name, capture] of captures) {
            try {
                await capture();
            } catch (captureError) {
                this.log(`Could not capture ${name}: ${errorRecord(captureError).message}`);
            }
        }
        await this.#writeRunRecord();
        for (const { logPath, name } of this.children) {
            try {
                const contents = await readFile(logPath, "utf8");
                process.stderr.write(`\n--- ${name} (${logPath}) ---\n${contents.slice(-12_000)}\n`);
            } catch {
                // The process may have failed before its log was created.
            }
        }
        this.log(`diagnostics: ${this.artifactDirectory}`);
    }

    async close(success: boolean) {
        if (this.browserState.kind === "recording") {
            try {
                await this.browserState.context.tracing.stop();
            } catch (error) {
                this.log(`Could not stop browser tracing: ${errorRecord(error).message}`);
            }
            this.browserState = { ...this.browserState, kind: "stopped" };
        }
        try {
            if (this.browserState.kind !== "none") {
                await this.browserState.browser.close();
            }
        } catch (error) {
            this.log(`Could not close browser: ${errorRecord(error).message}`);
        }
        for (const processRecord of this.children.toReversed()) {
            await this.#stopProcess(processRecord);
        }
        this.result = { kind: "finished", finishedAt: Date.now(), success };
        await this.#writeRunRecord();
        if (success && !this.preserveArtifacts) {
            await rm(this.rootDirectory, { recursive: true, force: true });
        } else {
            this.log(`kept diagnostics: ${this.artifactDirectory}`);
        }
    }

    async #assertProcessesRunning() {
        const exited = this.children.find(({ child }) => child.exitCode !== null || child.signalCode !== null);
        if (exited === undefined) {
            return;
        }
        const contents = await readFile(exited.logPath, "utf8");
        throw new Error(
            `${exited.name} exited with ${exited.child.exitCode ?? exited.child.signalCode}:\n${contents.slice(-4_000)}`,
        );
    }

    async #stopProcess({ child, name, output }: ProcessRecord) {
        try {
            if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
                await stopProcessTree(child);
            }
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
                this.log(`Could not stop ${name}: ${errorRecord(error).message}`);
            }
        } finally {
            closeSync(output);
        }
    }

    async #writeRunRecord() {
        await writeFile(
            join(this.artifactDirectory, "run.json"),
            `${JSON.stringify(
                {
                    name: this.name,
                    status:
                        this.failure === undefined
                            ? this.result.kind === "finished" && this.result.success
                                ? "passed"
                                : "running"
                            : "failed",
                    startedAt: new Date(this.startedAt).toISOString(),
                    ...(this.result.kind === "running"
                        ? {}
                        : { finishedAt: new Date(this.result.finishedAt).toISOString() }),
                    ...(this.result.kind === "running"
                        ? {}
                        : { durationMilliseconds: this.result.finishedAt - this.startedAt }),
                    stages: this.stages,
                    ...(this.failure === undefined ? {} : { failure: this.failure }),
                },
                null,
                2,
            )}\n`,
        );
    }
}

export async function runE2E(name: string, scenario: (harness: E2EHarness) => Promise<void>) {
    const harness = await E2EHarness.create(name);
    try {
        await scenario(harness);
        await harness.close(true);
    } catch (error) {
        await harness.diagnose(error);
        await harness.close(false);
        throw error;
    }
}
