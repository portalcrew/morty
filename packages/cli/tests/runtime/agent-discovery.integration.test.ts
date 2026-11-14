import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAgentDiagnostics } from "../../src/cli/handler/agents/logic/agent-diagnostics.ts";
import { discoverLocalAgentInventory } from "../../src/engine/agent/discovery/discover-local-agents.ts";
import { resolveAgentExecutables } from "../../src/engine/agent/discovery/executable-discovery.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { executableSource } from "../support/agents/executable.ts";

describe("local Agent discovery", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("Given Pi needs local authentication, When discovery runs through the in-process adapter, Then Morty reports only the Pi terminal login entrypoint", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "morty-pi-authentication-"));
        const piPath = join(temporaryDirectory, "pi");
        const sessionPath = join(temporaryDirectory, "session.jsonl");
        try {
            await writeFile(
                piPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.85.0\\n");
} else {
  const { createInterface } = await import("node:readline");
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const data = request.type === "get_available_models"
      ? { models: [] }
      : { sessionId: "pi-authentication", sessionFile: ${JSON.stringify(sessionPath)} };
    process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true, data }) + "\\n");
  });
}
`),
                { mode: 0o700 },
            );
            await chmod(piPath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                dataDirectory: temporaryDirectory,
                defaultWorkspace: temporaryDirectory,
                environment: {
                    MORTY_STATE_DIRECTORY: temporaryDirectory,
                    PATH: temporaryDirectory,
                },
                signal: new AbortController().signal,
                specifications: [new PiAgentSpecification()],
            });

            expect(inventory.available).toEqual([]);
            expect(inventory.unavailable).toHaveLength(1);
            expect(inventory.unavailable[0]).toMatchObject({
                code: "authentication_required",
                status: "authentication_required",
            });
            expect(JSON.parse(formatAgentDiagnostics(inventory, true))).toEqual({
                available: [],
                unavailable: [
                    {
                        code: "authentication_required",
                        harness: "pi",
                        label: "Pi",
                        message: "Agent authentication is required",
                        recoveryCommand: "pi",
                        status: "authentication_required",
                    },
                ],
            });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given PATH contains an Agent in the default working directory, When the paired computer discovers Agents, Then the working directory does not exclude that executable", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "morty-path-boundary-"));
        const codexPath = join(workspace, "codex");
        try {
            await writeFile(codexPath, executableSource('process.stdout.write("codex 0.153.0\\n");'), { mode: 0o700 });
            await chmod(codexPath, 0o700);
            const specification = new CodexAgentSpecification();

            await expect(
                resolveAgentExecutables(specification, {
                    dataDirectory: workspace,
                    defaultWorkspace: workspace,
                    environment: { PATH: workspace },
                    signal: new AbortController().signal,
                }).then((executables) => executables[0] ?? null),
            ).resolves.toMatchObject({ path: await realpath(codexPath) });
            await expect(
                resolveAgentExecutables(specification, {
                    dataDirectory: workspace,
                    defaultWorkspace: workspace,
                    environment: {
                        MORTY_CODEX_PATH: codexPath,
                        PATH: workspace,
                    },
                    signal: new AbortController().signal,
                }).then((executables) => executables[0] ?? null),
            ).resolves.toMatchObject({ path: await realpath(codexPath) });
        } finally {
            await rm(workspace, { force: true, recursive: true });
        }
    });
});
