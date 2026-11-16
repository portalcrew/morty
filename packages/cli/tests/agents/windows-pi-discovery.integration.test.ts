import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discoverLocalAgentInventory } from "../../src/engine/agent/discovery/discover-local-agents.ts";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.runIf(process.platform === "win32")(
    "Given Pi is installed through npm on Windows, When Morty discovers Agents, Then Pi can open a native session and is ready",
    async () => {
        await using provider = await FakeOpenAiProvider.start("morty-test-model", "WINDOWS_PI_READY");
        await using agent = await PiFixture.create(provider);
        expect(agent.executable).toMatch(/\.(?:js|mjs|cjs)$/iu);
        const directory = await mkdtemp(join(tmpdir(), "morty windows pi "));
        try {
            const inventory = await discoverLocalAgentInventory({
                dataDirectory: join(directory, "state"),
                defaultWorkspace: directory,
                environment: { ...process.env, ...agent.environment },
                signal: AbortSignal.timeout(30_000),
                specifications: [new PiAgentSpecification()],
            });
            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            expect(inventory.available[0]).toMatchObject({
                specification: { harness: "pi" },
                status: "ready",
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
