import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piProcessHost } from "../../../src/engine/acp/adapter/pi/process-host.ts";
import { PiAcpAgent } from "../../../src/engine/acp/harness/pi/upstream/dist/acp/agent.js";
import type { PiAcpClient } from "../../../src/engine/acp/harness/pi/upstream/dist/acp/client.js";

import { FakeOpenAiProvider } from "../llm/openai.ts";
import { resolveTestExecutable } from "./executable.ts";

export class PiFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(provider: FakeOpenAiProvider): Promise<PiFixture> {
        const executable = await resolveTestExecutable("pi", "MORTY_TEST_PI_PATH");
        const directory = await mkdtemp(join(tmpdir(), "morty-agent-daemon-pi-"));
        const configDirectory = join(directory, ".pi", "agent");
        const missing = join(directory, "missing-agent");
        await mkdir(configDirectory, { recursive: true });
        await Promise.all([
            writeFile(
                join(configDirectory, "models.json"),
                `${JSON.stringify({ providers: { openai: { baseUrl: `${provider.origin}/v1` } } }, null, 2)}\n`,
                { mode: 0o600 },
            ),
            writeFile(
                join(configDirectory, "settings.json"),
                `${JSON.stringify(
                    {
                        defaultModel: provider.model,
                        defaultProvider: "openai",
                        defaultThinkingLevel: "off",
                        enableInstallTelemetry: false,
                        quietStartup: true,
                        transport: "sse",
                    },
                    null,
                    2,
                )}\n`,
                { mode: 0o600 },
            ),
        ]);
        return new PiFixture(directory, executable, {
            HOME: directory,
            MORTY_CLAUDE_PATH: missing,
            MORTY_CODEX_PATH: missing,
            MORTY_PI_PATH: executable,
            NO_BROWSER: "1",
            OPENAI_API_KEY: FakeOpenAiProvider.apiKey,
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            PI_TELEMETRY: "0",
            XDG_CACHE_HOME: join(directory, "cache"),
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_DATA_HOME: join(directory, "data"),
            XDG_STATE_HOME: join(directory, "state"),
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.#directory, { force: true, recursive: true });
    }

    async installExtension(name: string, source: string): Promise<void> {
        const extensions = join(this.#directory, ".pi", "agent", "extensions");
        await mkdir(extensions, { recursive: true });
        await writeFile(join(extensions, name), source, { mode: 0o600 });
    }

    createClient(callbacks: PiAcpClient, command = this.executable): PiAcpAgent {
        return new PiAcpAgent(callbacks, {
            processes: piProcessHost,
            environment: { ...process.env, ...this.environment, PI_ACP_PI_COMMAND: command },
        });
    }

    async createLauncher(): Promise<{
        readonly command: string;
        readonly pidFile: string;
        readonly stoppedFile: string;
    }> {
        const command = join(this.#directory, "pi launcher");
        const pidFile = join(this.#directory, "pi-child.pid");
        const stoppedFile = join(this.#directory, "launcher-stopped");
        const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
        await writeFile(
            command,
            `#!/bin/sh\ntrap ${quote(`printf stopped > ${quote(stoppedFile)}; exit 0`)} TERM\nexec 3<&0\n${quote(this.executable)} "$@" <&3 &\nchild=$!\nprintf '%s' "$child" > ${quote(pidFile)}\nwait "$child"\n`,
            { mode: 0o700 },
        );
        return { command, pidFile, stoppedFile };
    }

    async seedSession(cwd: string, prompt: string, signal: AbortSignal): Promise<void> {
        const child = spawn(this.executable, ["--mode", "json", "--print", prompt], {
            cwd,
            env: { ...process.env, ...this.environment },
            signal,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        await new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) =>
                code === 0 ? resolve() : reject(new Error(`Native Pi seed failed: ${output}`)),
            );
        });
    }

    async overrideSettings(settings: Record<string, unknown>): Promise<void> {
        const settingsPath = join(this.#directory, ".pi", "agent", "settings.json");
        const current = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
        await writeFile(settingsPath, `${JSON.stringify({ ...current, ...settings }, null, 2)}\n`, { mode: 0o600 });
    }
}
