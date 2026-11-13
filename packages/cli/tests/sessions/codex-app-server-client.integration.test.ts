import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import { stopProcessTree } from "../../src/engine/util/process/executable.ts";
import { testAgentDefinition } from "../support/agent-definition.ts";
import { imageFixture } from "../support/agents/image-fixture.ts";
import { loadCodexHistory, previewCodexHistory } from "../support/codex-history-preview.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

async function appServer(responseCharacters = 1024 * 1024): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "morty-codex-app-server-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "codex");
    await writeFile(
        executable,
        `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const result = message.method === "initialize" ? {} : "x".repeat(${responseCharacters.toString()});
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`,
        "utf8",
    );
    await chmod(executable, 0o755);
    return executable;
}

async function historyAppServer(
    savedItems: readonly unknown[] | null = null,
    error: { readonly message: string } | null = null,
): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "morty-codex-history-server-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "codex");
    await writeFile(
        executable,
        `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const savedItems = ${JSON.stringify(savedItems)};
input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
        return;
    }
    if (message.method === "thread/read") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, cwd: ${JSON.stringify(process.cwd())} } } }) + "\\n");
        return;
    }
    if (message.method === "thread/resume") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } }) + "\\n");
        return;
    }
    if (message.method === "model/list" || message.method === "thread/settings/update") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { data: [] } }) + "\\n");
        return;
    }
    const page = Number(message.params.cursor ?? 0);
    const result = {
        data: [{
            id: "turn-" + page,
            status: ${JSON.stringify(error === null ? "completed" : "failed")},
            error: ${JSON.stringify(error)},
            padding: savedItems === null ? "x".repeat(9 * 1024 * 1024) : "",
            items: savedItems ?? [{ id: "message-" + page, phase: "final_answer", text: "Reply " + page, type: "agentMessage" }],
        }],
        nextCursor: savedItems === null && page < 3 ? String(page + 1) : null,
    };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});

`,
        "utf8",
    );
    await chmod(executable, 0o755);
    return executable;
}

it("Given a long-lived Codex app-server returns more than 32 MiB across consumed messages, When another request completes, Then the healthy connection remains usable", async () => {
    const command = await appServer();
    const client = new CodexAppServerClient({
        command,
        cwd: process.cwd(),
        environment: {},
        handlers: {
            onNotification: async () => {},
            onServerRequest: async () => {},
        },
    });
    try {
        const signal = AbortSignal.timeout(30_000);
        await client.initialize(signal);
        for (let request = 0; request < 34; request += 1) {
            await expect(client.request("history/read", {}, signal)).resolves.toHaveLength(1024 * 1024);
        }
    } finally {
        client.detach();
        await stopProcessTree(client.child());
    }
});

it("Given Codex sends an individual protocol message above 32 MiB, When Morty receives it, Then the connection stops at the bounded transport boundary", async () => {
    const command = await appServer(33 * 1024 * 1024);
    const client = new CodexAppServerClient({
        command,
        cwd: process.cwd(),
        environment: {},
        handlers: {
            onNotification: async () => {},
            onServerRequest: async () => {},
        },
    });
    try {
        const signal = AbortSignal.timeout(30_000);
        await client.initialize(signal);
        await expect(client.request("history/read", {}, signal)).rejects.toMatchObject({
            code: "codex_app_server_output_limit",
        });
    } finally {
        client.detach();
        await stopProcessTree(client.child());
    }
});

it("Given a non-Codex agent, When its history is requested through the Codex adapter, Then the adapter reports an agent mismatch rather than an executable change", async () => {
    const command = await historyAppServer();
    const agent = testAgentDefinition("claude", "Claude", command);
    await expect(previewCodexHistory(agent, process.cwd(), "saved-thread")).rejects.toMatchObject({
        code: "agent_adapter_mismatch",
    });
});

it("Given paginated Codex history exceeds 32 MiB across consumed responses, When Morty reads every page, Then the bounded history reader completes", async () => {
    const command = await historyAppServer();
    const agent = testAgentDefinition("codex", "Codex", command);

    const page = await previewCodexHistory(agent, process.cwd(), "large-history");
    expect(page.events).toHaveLength(4);
});

it.each([
    {
        name: "250-item turn",
        extra: Array.from({ length: 248 }, (_, index) => ({ id: `unknown-${index}`, type: "futureItem" })),
    },
    {
        name: "large tool snapshot",
        extra: [
            {
                id: "tool",
                type: "mcpToolCall",
                server: "saved",
                tool: "read",
                status: "completed",
                result: { text: "x".repeat(300_000) },
            },
        ],
    },
])(
    "Given a saved Codex $name, When it is previewed and opened, Then both retain identical prompt, answer and tool content",
    async ({ extra }) => {
        const items = [
            { id: "user", type: "userMessage", content: [{ type: "text", text: "Saved prompt" }] },
            { id: "answer", type: "agentMessage", text: "Saved answer", phase: "final_answer" },
            ...extra,
        ];
        const command = await historyAppServer(items);
        const agent = testAgentDefinition("codex", "Codex", command);
        const preview = await previewCodexHistory(agent, process.cwd(), "saved-thread");
        const opened = await loadCodexHistory(agent, process.cwd(), "saved-thread");
        const updates = (page: typeof preview) =>
            page.events.flatMap((event) =>
                event.type === "acp" &&
                (event.payload.sessionUpdate === "user_message_chunk" ||
                    event.payload.sessionUpdate === "agent_message_chunk" ||
                    event.payload.sessionUpdate === "tool_call")
                    ? [event.payload]
                    : [],
            );
        expect(updates(preview)).toEqual(updates(opened));
        expect(updates(preview)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    sessionUpdate: "user_message_chunk",
                    content: { type: "text", text: "Saved prompt" },
                }),
                expect.objectContaining({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Saved answer" },
                }),
            ]),
        );
        expect(preview.nextCursor).toBeNull();
    },
);

it.each(["mcpToolCall", "dynamicToolCall"])(
    "Given a saved Codex %s result exceeds SDK limits, When history is previewed and opened, Then a marked bounded result and surrounding messages remain readable",
    async (type) => {
        const result = {
            text: "Large saved result ".repeat(60_000),
            content: [{ type: "image", data: imageFixture(16).toString("base64"), mimeType: "image/png" }],
        };
        const items = [
            { id: "user", type: "userMessage", content: [{ type: "text", text: "Saved prompt" }] },
            { id: "answer", type: "agentMessage", text: "Saved answer", phase: "final_answer" },
            {
                id: "tool",
                type,
                server: "saved",
                tool: "read",
                status: "completed",
                ...(type === "mcpToolCall" ? { result } : { contentItems: [result] }),
            },
        ];
        const command = await historyAppServer(items);
        const agent = testAgentDefinition("codex", "Codex", command);
        const preview = await previewCodexHistory(agent, process.cwd(), "saved-thread");
        const opened = await loadCodexHistory(agent, process.cwd(), "saved-thread");
        for (const page of [preview, opened]) {
            const updates = page.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
            expect(updates).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        sessionUpdate: "user_message_chunk",
                        content: { type: "text", text: "Saved prompt" },
                    }),
                    expect.objectContaining({
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "Saved answer" },
                    }),
                ]),
            );
            const tool = updates.find((update) => update.sessionUpdate === "tool_call");
            expect(tool).toMatchObject({
                rawOutput: { truncated: true, text: expect.stringContaining("Large saved result") },
            });
            expect(tool).toMatchObject({
                content: expect.arrayContaining([
                    expect.objectContaining({
                        type: "content",
                        content: expect.objectContaining({ type: "external_image", imageKey: expect.any(String) }),
                    }),
                ]),
            });
            expect(JSON.stringify(tool).length).toBeLessThan(100_000);
        }
    },
);

it("Given a saved Codex tool result exceeds the nesting limit, When it is previewed and opened, Then marked tool content, surrounding messages and shallow images remain readable", async () => {
    let nested: unknown = { text: "Deep saved result" };
    for (let depth = 0; depth < 18; depth += 1) {
        nested = { child: nested };
    }
    const command = await historyAppServer([
        { id: "user", type: "userMessage", content: [{ type: "text", text: "Saved prompt" }] },
        { id: "answer", type: "agentMessage", text: "Saved answer", phase: "final_answer" },
        {
            id: "tool",
            type: "mcpToolCall",
            server: "saved",
            tool: "read",
            status: "completed",
            result: {
                structuredContent: nested,
                content: [{ type: "image", data: imageFixture(16).toString("base64"), mimeType: "image/png" }],
            },
        },
    ]);
    const agent = testAgentDefinition("codex", "Codex", command);
    const preview = await previewCodexHistory(agent, process.cwd(), "saved-thread");
    const opened = await loadCodexHistory(agent, process.cwd(), "saved-thread");
    for (const page of [preview, opened]) {
        const updates = page.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
        expect(updates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    sessionUpdate: "user_message_chunk",
                    content: { type: "text", text: "Saved prompt" },
                }),
                expect.objectContaining({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Saved answer" },
                }),
            ]),
        );
        const tool = updates.find((update) => update.sessionUpdate === "tool_call");
        expect(JSON.stringify(tool)).toContain("[truncated: nesting depth]");
        expect(JSON.stringify(tool)).toContain("Deep saved result");
        expect(tool).toMatchObject({
            content: expect.arrayContaining([
                expect.objectContaining({
                    type: "content",
                    content: expect.objectContaining({ type: "external_image", imageKey: expect.any(String) }),
                }),
            ]),
        });
    }
});

it("Given a saved failed Codex turn has no assistant answer, When it is previewed and opened, Then both show the bounded native failure with a stable identity", async () => {
    const command = await historyAppServer(
        [{ id: "user", type: "userMessage", content: [{ type: "text", text: "Saved failed prompt" }] }],
        { message: "Native failure ".repeat(1_000) },
    );
    const agent = testAgentDefinition("codex", "Codex", command);
    const preview = await previewCodexHistory(agent, process.cwd(), "saved-thread");
    const opened = await loadCodexHistory(agent, process.cwd(), "saved-thread");
    const failures = (page: typeof preview) =>
        page.events.flatMap((event) =>
            event.type === "acp" && event.payload.sessionUpdate === "tool_call" && event.payload.status === "failed"
                ? [event.payload]
                : [],
        );
    expect(failures(preview)).toHaveLength(1);
    expect(failures(preview)).toEqual(failures(opened));
    expect(failures(preview)[0]).toMatchObject({
        title: "Agent error",
        rawOutput: { message: expect.stringContaining("Native failure") },
    });
    expect(JSON.stringify(failures(preview)).length).toBeLessThan(10_000);
});
