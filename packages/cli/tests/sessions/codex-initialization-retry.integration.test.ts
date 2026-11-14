import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { harnessAdapters } from "../../src/engine/acp/adapter/registry.ts";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { MemorySessionStore } from "../../src/engine/session/record/session-store.ts";
import { systemTimer } from "../../src/engine/util/timer.ts";
import { testAgentDefinition } from "../support/agent-definition.ts";
import { SessionRuntimeFixture } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";

test("Given Codex initialization fails once, When the user creates a conversation, Then the same operation recovers and returns the new conversation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    const directory = await mkdtemp(join(tmpdir(), "morty-codex-initialize-"));
    const command = join(directory, "codex.mjs");
    const sessions = new SessionRuntimeFixture({
        observer: {},
        store: new MemorySessionStore(),
        adapters: harnessAdapters,
        onSessionClosed: () => undefined,
        lastTurn: () => undefined,
        settledTurns: () => [],
        contentExternalizer: new AcpContentExternalizer((target, content, signal) =>
            new UnretainedExternalContentStore().put({ ...content, target, signal }),
        ),
        timer: systemTimer,
        maxProcesses: null,
    });
    try {
        await writeFile(
            command,
            `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = ${JSON.stringify(join(directory, "initialized"))};
createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "initialize" && !existsSync(marker)) {
        writeFileSync(marker, "failed once");
        process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32603, message: "Recoverable startup failure" } }) + "\\n");
        return;
    }
    const result = request.method === "thread/start" ? { thread: { id: "recovered-thread" } }
        : request.method === "model/list" ? { data: [], nextCursor: null } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
            { mode: 0o700 },
        );
        const agent = testAgentDefinition("codex", "Codex", command, {});
        await expect(
            sessions.createNativeSession({ agent, cwd: directory, signal: AbortSignal.timeout(30_000) }),
        ).resolves.toEqual({ harness: "codex", sessionId: "recovered-thread" });
    } finally {
        await sessions.close();
        await rm(directory, { recursive: true, force: true });
        vi.useRealTimers();
    }
});
