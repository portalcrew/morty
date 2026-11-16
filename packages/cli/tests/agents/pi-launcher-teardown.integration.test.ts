import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { waitForAgentFile } from "../support/agents/observed-process.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

const owned = new Set<number>();

afterEach(() => {
    for (const pid of owned) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {}
    }
    owned.clear();
    vi.useRealTimers();
});

test.skipIf(process.platform === "win32")(
    "Given real Pi runs behind a shell launcher and is stalled, When the harness is disposed, Then Pi is retired even after its launcher exits and disposal settles",
    async ({ signal }) => {
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_LAUNCHER_REPLY");
        await using fixture = await PiFixture.create(provider);
        const launcher = await fixture.createLauncher();
        const rejectInteraction = async (): Promise<never> => {
            throw new Error("Unexpected interaction during Pi setup");
        };
        const client = fixture.createClient(
            {
                sessionUpdate: async () => undefined,
                startUserMessage: () => undefined,
                requestPermission: rejectInteraction,
                requestElicitation: rejectInteraction,
            },
            launcher.command,
        );
        await client.newSession({ cwd: dirname(launcher.command), mcpServers: [] });
        const pid = Number(await readFile(launcher.pidFile, "utf8"));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        owned.add(pid);
        process.kill(pid, "SIGSTOP");
        vi.useFakeTimers({ now: new Date("2026-11-10T00:00:00Z"), toFake: ["setTimeout", "clearTimeout", "Date"] });
        const stopped = waitForAgentFile(launcher.stoppedFile, true, signal);
        const closing = client.dispose();
        await stopped;
        await vi.advanceTimersByTimeAsync(1_000);
        await closing;
        expect(() => process.kill(pid, 0)).toThrow();
        owned.delete(pid);
    },
);
