import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { harnessAdapters } from "../../src/engine/acp/adapter/registry.ts";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { discoverLocalAgentInventory } from "../../src/engine/agent/discovery/discover-local-agents.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { RecordingObserver } from "../sessions/acp-feature-fixture.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";

test("Given real Codex initializes but its process is killed during model discovery, When discovery completes, Then the dead backend is unavailable", async () => {
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "DISCOVERY_REPLY");
    await using codex = await CodexFixture.create(provider);
    const directory = await mkdtemp(join(tmpdir(), "morty-real-codex-exit-"));
    try {
        const executable = join(directory, "codex.mjs");
        await writeFile(
            executable,
            `#!${process.execPath}
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const child = spawn(${JSON.stringify(codex.executable)}, process.argv.slice(2), { stdio: ["pipe", "inherit", "inherit"], env: {...process.env, ...${JSON.stringify(codex.environment)}} });
createInterface({input:process.stdin}).on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "model/list") child.kill("SIGKILL");
    else child.stdin.write(line + "\\n");
});
child.once("error", () => process.exit(1));
child.once("exit", code => process.exit(code ?? 1));
`,
            { mode: 0o700 },
        );
        const inventory = await discoverLocalAgentInventory({
            dataDirectory: directory,
            defaultWorkspace: directory,
            environment: { ...codex.environment, MORTY_CODEX_PATH: executable },
            signal: AbortSignal.timeout(30_000),
            specifications: [new CodexAgentSpecification()],
        });
        expect(inventory.available).toEqual([]);
        expect(inventory.unavailable).toEqual([
            expect.objectContaining({
                specification: expect.objectContaining({ harness: "codex" }),
                status: "incompatible_adapter",
            }),
        ]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test.skipIf(process.platform === "win32")(
    "Given a discovered real Codex executable changes, When the existing conversation continues and a new one opens, Then the existing process works and the new computer is rejected",
    async () => {
        await using provider = await FakeOpenAiProvider.start("morty-test-model", "IDENTITY_REPLY");
        await using codex = await CodexFixture.create(provider);
        const directory = await mkdtemp(join(tmpdir(), "morty-real-codex-identity-"));
        const observer = new RecordingObserver();
        const manager = new SessionManager({
            observer,
            store: new MemorySessionStore(),
            adapters: harnessAdapters,
            onSessionClosed: () => undefined,
            lastEndedTurn: () => undefined,
            settledTurns: () => [],
            hasUnsettledTurn: () => false,
            contentExternalizer: new AcpContentExternalizer((sessionTarget, content, signal) =>
                new UnretainedExternalContentStore().put({
                    bytes: content.bytes,
                    kind: content.kind,
                    mediaType: content.mediaType,
                    name: content.name,
                    target: sessionTarget,
                    signal,
                }),
            ),
            timer: systemTimer,
            maxProcesses: null,
        });
        try {
            const first = join(directory, "first.mjs");
            const second = join(directory, "second.mjs");
            const link = join(directory, "codex");
            await codex.writeLauncher(first);
            await codex.writeLauncher(second);
            await symlink(first, link);
            const inventory = await discoverLocalAgentInventory({
                dataDirectory: directory,
                defaultWorkspace: directory,
                environment: { ...codex.environment, MORTY_CODEX_PATH: link },
                signal: AbortSignal.timeout(30_000),
                specifications: [new CodexAgentSpecification()],
            });
            const agent = inventory.readyAgents()[0];
            if (agent === undefined) {
                throw new Error("Real Codex was not discovered");
            }
            const options = { agent, cwd: directory, signal: AbortSignal.timeout(30_000) };
            const sessionTarget = await manager.createNativeSession(options);
            const run = async (): Promise<string> => {
                observer.events.length = 0;
                await manager.runPrompt({
                    agent,
                    target: sessionTarget,
                    cwd: directory,
                    commandId: crypto.randomUUID(),
                    prompt: "Hello",
                    images: [],
                    resources: [],
                    signal: AbortSignal.timeout(30_000),
                });
                return observer.agentText();
            };
            expect(await run()).toContain("IDENTITY_REPLY");
            await unlink(link);
            await symlink(second, link);
            expect(await run()).toContain("IDENTITY_REPLY");
            await expect(manager.createNativeSession(options)).rejects.toMatchObject({ code: "agent_runtime_changed" });
        } finally {
            await manager.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);
