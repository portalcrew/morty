import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import { expect, test } from "vitest";
import { z } from "zod";
import { PiFixture } from "../support/agents/pi.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.each([
    { settings: '{"__proto__":{"quietStartup":true}}', quiet: false },
    { settings: '{"quietStartup":true}', quiet: true },
])(
    "Given project settings $settings, When real Pi starts an ACP session, Then only an own quietStartup setting suppresses startup information",
    async ({ settings, quiet }) => {
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_SETTINGS_REPLY");
        await using fixture = await PiFixture.create(provider);
        await fixture.overrideSettings({ quietStartup: undefined });
        const cwd = await mkdtemp(join(tmpdir(), "morty-pi-settings-"));
        const rejectInteraction = async (): Promise<never> => {
            throw new Error("Unexpected interaction during session initialization");
        };
        const client = fixture.createClient({
            requestElicitation: rejectInteraction,
            requestPermission: rejectInteraction,
            sessionUpdate: async () => undefined,
            startUserMessage: () => undefined,
        });
        try {
            await mkdir(join(cwd, ".pi"));
            await writeFile(join(cwd, ".pi", "settings.json"), settings, { mode: 0o600 });
            const contextPath = join(cwd, "AGENTS.md");
            await writeFile(contextPath, "Project context for the settings integration scenario.\n");
            await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
            const response = await client.newSession({ cwd, mcpServers: [] });
            const { piAcp } = z
                .object({ piAcp: z.object({ startupInfo: z.string().nullable() }) })
                .parse(response._meta);
            expect(piAcp.startupInfo?.includes(contextPath) ?? false).toBe(!quiet);
        } finally {
            await client.dispose();
            await rm(cwd, { recursive: true, force: true });
        }
    },
);
