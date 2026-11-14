import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executableLaunch } from "../../../src/engine/util/process/executable.ts";
import { FakeOpenAiProvider } from "../llm/openai.ts";
import { resolveTestExecutable } from "./executable.ts";

export class CodexFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly executable: string;
    readonly #directory: string;

    private constructor(directory: string, executable: string, environment: Readonly<Record<string, string>>) {
        this.#directory = directory;
        this.executable = executable;
        this.environment = environment;
    }

    static async create(
        provider: FakeOpenAiProvider,
        options: {
            readonly approvalPolicy?: "never" | "on-request";
            readonly autoCompactTokenLimit?: number;
            readonly configuredModel?: string;
            /** Experimental Codex tools the configured model's catalog entry enables, such as `send_user_message_async`. */
            readonly modelTools?: readonly string[];
        } = {},
    ): Promise<CodexFixture> {
        // Codex is an in-process Agent: there is no ACP adapter to resolve, only the real binary
        // that Morty drives through `codex app-server`.
        const executable = await resolveTestExecutable("codex", "MORTY_TEST_CODEX_PATH");
        const directory = await mkdtemp(join(tmpdir(), "morty-agent-daemon-codex-"));
        const codexHome = join(directory, "codex");
        const missing = join(directory, "missing-agent");
        await mkdir(codexHome, { recursive: true });
        const modelCatalog = join(directory, "model-catalog.json");
        if (options.modelTools !== undefined) {
            if (options.configuredModel === undefined) {
                throw new Error("Model tools need a configured model");
            }
            // The smallest catalog entry Codex accepts; the tools it lists are what the model is offered.
            await writeFile(
                modelCatalog,
                JSON.stringify({
                    models: [
                        {
                            base_instructions: "You are a test model.",
                            display_name: options.configuredModel,
                            experimental_supported_tools: options.modelTools,
                            priority: 1,
                            shell_type: "unified_exec",
                            slug: options.configuredModel,
                            support_verbosity: false,
                            supported_in_api: true,
                            supported_reasoning_levels: [{ description: "Low", effort: "low" }],
                            truncation_policy: { limit: 10_000, mode: "tokens" },
                            visibility: "list",
                        },
                    ],
                }),
            );
        }
        await writeFile(
            join(codexHome, "config.toml"),
            [
                ...(options.configuredModel === undefined
                    ? []
                    : [`model = ${JSON.stringify(options.configuredModel)}`]),
                ...(options.modelTools === undefined ? [] : [`model_catalog_json = ${JSON.stringify(modelCatalog)}`]),
                ...(options.autoCompactTokenLimit === undefined
                    ? []
                    : [`model_auto_compact_token_limit = ${options.autoCompactTokenLimit.toString()}`]),
                'model_provider = "morty"',
                'model_reasoning_effort = "low"',
                'model_reasoning_summary = "none"',
                // The CI host cannot create the sandbox namespaces Codex needs, so the fixture runs
                // its tool calls without one. This is Codex configuration, not Morty policy.
                'sandbox_mode = "danger-full-access"',
                `approval_policy = ${JSON.stringify(options.approvalPolicy ?? "never")}`,
                "",
                "[model_providers.morty]",
                'name = "Morty fake provider"',
                `base_url = ${JSON.stringify(`${provider.origin}/v1`)}`,
                'env_key = "CODEX_API_KEY"',
                'wire_api = "responses"',
                "request_max_retries = 0",
                "stream_max_retries = 0",
                "supports_websockets = false",
                "",
                "[features]",
                "plugins = false",
                "",
            ].join("\n"),
            { mode: 0o600 },
        );
        return new CodexFixture(directory, executable, {
            CODEX_API_KEY: FakeOpenAiProvider.apiKey,
            CODEX_HOME: codexHome,
            DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
            HOME: directory,
            MORTY_CLAUDE_PATH: missing,
            MORTY_CODEX_PATH: executable,
            MORTY_PI_PATH: missing,
            NO_PROXY: "127.0.0.1,localhost",
            NO_BROWSER: "1",
            PATH: process.env["PATH"] ?? "",
            XDG_CACHE_HOME: join(directory, "cache"),
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_DATA_HOME: join(directory, "data"),
            XDG_STATE_HOME: join(directory, "state"),
            no_proxy: "127.0.0.1,localhost",
        });
    }

    async writeLauncher(path: string): Promise<void> {
        const launch = executableLaunch(this.executable, []);
        await writeFile(
            path,
            `#!${process.execPath}
import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(launch.command)}, [...${JSON.stringify(launch.arguments)}, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ...${JSON.stringify(this.environment)} } });
child.once("error", () => process.exit(1));
child.once("exit", (code) => process.exit(code ?? 1));
`,
            { mode: 0o700 },
        );
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.#directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
}
