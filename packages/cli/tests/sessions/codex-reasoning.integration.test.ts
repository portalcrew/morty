import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { expect, it } from "vitest";
import type { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import { reasoningText } from "../../src/engine/acp/harness/codex/items.ts";
import { CodexOwnedAcpAgent } from "../../src/engine/acp/harness/codex/owned-agent.ts";
import type { CodexSettings } from "../../src/engine/acp/harness/codex/settings.ts";
import { testAgentDefinition } from "../support/agent-definition.ts";
import { previewCodexHistory } from "../support/codex-history-preview.ts";

it("Given Codex streams detailed reasoning and a summary, When Morty forwards the turn, Then Thinking keeps the reasoning stream", async ({
    signal,
}) => {
    const updates: SessionNotification["update"][] = [];
    let resolveTurnStart: ((value: unknown) => void) | undefined;
    const turnStart = new Promise<unknown>((resolve) => {
        resolveTurnStart = resolve;
    });
    const client = {
        request: async (method: string): Promise<unknown> => (method === "turn/start" ? await turnStart : {}),
    } as unknown as CodexAppServerClient;
    const settings = { turnParameters: () => ({}) } as unknown as CodexSettings;
    const agent = new CodexOwnedAcpAgent({
        client,
        close: async () => {},
        signal: new AbortController().signal,
        interactions: {
            onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
            onElicitation: async () => ({ action: "cancel" }),
        },
        emit: async (update) => {
            updates.push(update);
        },
        settings,
        threadId: () => "thread",
    });

    const running = agent.prompt([], signal, []);
    resolveTurnStart?.({ turn: { id: "turn", status: "inProgress" } });
    await Promise.resolve();
    await Promise.resolve();
    await agent.onNotification("item/agentMessage/delta", {
        delta: "Progress update",
        itemId: "commentary",
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/reasoning/summaryTextDelta", {
        delta: "Short summary",
        itemId: "reasoning",
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/reasoning/textDelta", {
        delta: "Detailed chain of thought that should be shown",
        itemId: "reasoning",
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/completed", {
        item: {
            content: ["Detailed chain of thought that should be shown"],
            id: "reasoning",
            summary: ["Short summary"],
            type: "reasoning",
        },
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/reasoning/summaryTextDelta", {
        delta: "Summary-only stream",
        itemId: "reasoning-summary-only",
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("item/completed", {
        item: {
            content: ["Detailed reasoning recovered at completion"],
            id: "reasoning-summary-only",
            summary: ["Summary-only stream"],
            type: "reasoning",
        },
        threadId: "thread",
        turnId: "turn",
    });
    await agent.onNotification("turn/completed", {
        threadId: "thread",
        turn: { id: "turn", status: "completed" },
    });
    await running;

    expect(
        updates
            .filter((update) => update.sessionUpdate === "agent_thought_chunk")
            .map((update) => (update.content.type === "text" ? update.content.text : "")),
    ).toEqual([
        "Short summary",
        "Detailed chain of thought that should be shown",
        "Summary-only stream",
        "Detailed reasoning recovered at completion",
    ]);
    expect(
        updates
            .filter((update) => update.sessionUpdate === "agent_message_chunk")
            .map((update) => (update.content.type === "text" ? update.content.text : "")),
    ).toEqual(["Progress update"]);
    expect(
        reasoningText({
            content: ["Detailed chain of thought"],
            id: "reasoning-without-summary",
            summary: [],
            type: "reasoning",
        }),
    ).toBe("Detailed chain of thought");
});

it("Given saved Codex history contains commentary and detailed reasoning, When Morty previews it, Then commentary stays assistant output and detailed reasoning becomes Thinking", async () => {
    const directory = await mkdtemp(join(tmpdir(), "morty-codex-history-summary-"));
    const executable = join(directory, "codex.mjs");
    const sessionId = "native-codex";
    await writeFile(
        executable,
        `#!${process.execPath}
import { createInterface } from "node:readline";

const history = {
    data: [{
        error: null,
        id: "turn-1",
        items: [
            { id: "user-1", content: [{ text: "Prompt", type: "text" }], type: "userMessage" },
            { id: "commentary-1", phase: "commentary", text: "Progress update", type: "agentMessage" },
            { content: ["Detailed reasoning"], id: "reasoning-1", summary: ["Short summary"], type: "reasoning" },
            { content: ["Detailed reasoning without summary"], id: "reasoning-2", summary: [], type: "reasoning" },
            { content: [], id: "reasoning-3", summary: ["Summary fallback"], type: "reasoning" },
            { id: "answer-1", phase: "final_answer", text: "Answer", type: "agentMessage" },
        ],
        status: "completed",
    }],
    nextCursor: null,
};

createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = request.method === "thread/read"
        ? { thread: { cwd: process.cwd(), id: ${JSON.stringify(sessionId)} } }
        : request.method === "thread/turns/list"
          ? history
          : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
        { mode: 0o700 },
    );
    const agent = testAgentDefinition("codex", "Codex", executable);
    try {
        const page = await previewCodexHistory(agent, directory, sessionId);
        const updates = page.events.flatMap((event) => (event.type === "acp" ? [event.payload] : []));
        expect(
            updates.filter((update) => update.sessionUpdate === "agent_message_chunk").map((update) => update.content),
        ).toEqual([
            { type: "text", text: "Progress update" },
            { type: "text", text: "Answer" },
        ]);
        expect(
            updates
                .filter((update) => update.sessionUpdate === "agent_thought_chunk")
                .map((update) => ({ messageId: update.messageId, content: update.content })),
        ).toEqual([
            { messageId: "reasoning-1", content: { type: "text", text: "Detailed reasoning" } },
            { messageId: "reasoning-2", content: { type: "text", text: "Detailed reasoning without summary" } },
            { messageId: "reasoning-3", content: { type: "text", text: "Summary fallback" } },
        ]);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
