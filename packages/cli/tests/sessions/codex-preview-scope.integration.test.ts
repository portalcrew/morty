import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { SessionEventPage } from "../../src/engine/acp/native-history/preview-contract.ts";
import { testAgentDefinition } from "../support/agent-definition.ts";
import { codexHistoryAdapter } from "../support/codex-history-preview.ts";

async function previewFixture(signal: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), "morty-codex-preview-scope-"));
    const command = join(directory, "codex.mjs");
    await writeFile(
        command,
        `#!${process.execPath}
import { createInterface } from "node:readline";
const scope = process.env.CODEX_HOME;
createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = request.method === "thread/turns/list"
        ? { data: [{ id: "turn", status: "completed", items: [0, 1, 2].map(index => ({
            type: "agentMessage", id: "message-" + index,
            text: scope + ":" + request.params.threadId + ":" + index,
        })) }], nextCursor: null }
        : request.method === "model/list" ? { data: [], nextCursor: null } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
        { mode: 0o700 },
    );
    const agent = testAgentDefinition("codex", "Codex", command, { CODEX_HOME: "catalog" });
    const { adapter, processes } = codexHistoryAdapter(agent);
    return {
        adapter,
        read: (scope: string, sessionId: string, cursor: string | null = null) =>
            adapter.readSessionHistory({
                query: {
                    agent: agent.withEnvironment({ CODEX_HOME: scope }),
                    cwd: directory,
                    signal,
                },
                request: { sessionId, eventLimit: 1, cursor },
            }),
        [Symbol.asyncDispose]: async () => {
            try {
                await adapter.close();
            } finally {
                await processes.stopIdleReclamation();
                await rm(directory, { recursive: true, force: true });
            }
        },
    };
}

function messages(page: SessionEventPage): readonly string[] {
    return page.events.flatMap((event) =>
        event.type === "acp" &&
        event.payload.sessionUpdate === "agent_message_chunk" &&
        event.payload.content.type === "text"
            ? [event.payload.content.text]
            : [],
    );
}

test("Given two scoped Codex stores for the same thread, When history is previewed and paged in both scopes, Then launch and cursor identity retain each store's environment", async ({
    signal,
}) => {
    await using fixture = await previewFixture(signal);
    const first = await fixture.read("scope-one", "saved-thread");
    expect(messages(first)).toEqual(["scope-one:saved-thread:2"]);
    const second = await fixture.read("scope-two", "saved-thread");
    expect(messages(second)).toEqual(["scope-two:saved-thread:2"]);
    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).not.toBeNull();
    expect(messages(await fixture.read("scope-one", "saved-thread", first.nextCursor))).toEqual([
        "scope-one:saved-thread:1",
    ]);
    expect(messages(await fixture.read("scope-two", "saved-thread", second.nextCursor))).toEqual([
        "scope-two:saved-thread:1",
    ]);
});

test("Given many saved Codex threads, When the user browses beyond retained preview capacity, Then old cursors expire while recent pages and a refreshed old thread remain readable", async ({
    signal,
}) => {
    await using fixture = await previewFixture(signal);
    const oldest = await fixture.read("scoped", "thread-0");
    const recent = await fixture.read("scoped", "thread-1");
    expect(oldest.nextCursor).not.toBeNull();
    expect(recent.nextCursor).not.toBeNull();
    for (let index = 2; index < 40; index += 1) {
        await fixture.read("scoped", `thread-${index}`);
        // Reading a page keeps this still-visible conversation recently used.
        expect(messages(await fixture.read("scoped", "thread-1", recent.nextCursor))).toEqual(["scoped:thread-1:1"]);
    }
    await expect(fixture.read("scoped", "thread-0", oldest.nextCursor)).rejects.toMatchObject({
        code: "invalid_native_session_response",
    });
    expect(messages(await fixture.read("scoped", "thread-0"))).toEqual(["scoped:thread-0:2"]);
});
