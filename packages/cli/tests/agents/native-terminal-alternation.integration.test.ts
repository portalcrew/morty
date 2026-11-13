import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    type NativeSessionTarget,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { PiFixture } from "../support/agents/pi.ts";
import {
    type DaemonConnectionPeer,
    importRealSession,
    withRealDaemonConnection,
} from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

const agents = {
    claude: {
        start: async (conversations: string[]) => {
            const provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "ALTERNATION_REPLY", {
                beforeFirstText: async (_scenario, _signal, conversation) => {
                    conversations.push(conversation);
                },
            });
            return {
                provider,
                agent: await ClaudeFixture.create(provider),
                specification: new ClaudeCodeAgentSpecification(),
            };
        },
        // Each terminal run is a fresh native client, as when the user returns to `claude --resume`.
        terminal: (sessionId: string, first: boolean) => ["-p", first ? "--session-id" : "--resume", sessionId],
    },
    pi: {
        start: async (conversations: string[]) => {
            const provider = await FakeOpenAiProvider.start("gpt-4.1", "ALTERNATION_REPLY", {
                beforeFirstText: async (_signal, conversation) => {
                    conversations.push(conversation);
                },
            });
            return { provider, agent: await PiFixture.create(provider), specification: new PiAgentSpecification() };
        },
        terminal: (sessionId: string) => ["-p", "--session-id", sessionId],
    },
} as const;

async function continueInTerminal(
    executable: string,
    args: readonly string[],
    prompt: string,
    cwd: string,
    environment: Readonly<Record<string, string>>,
): Promise<void> {
    const child = spawn(executable, [...args, prompt], {
        cwd,
        env: { ...process.env, ...environment },
        signal: AbortSignal.timeout(120_000),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`Terminal turn failed: ${output}`))));
    });
}

async function promptFromMorty(
    peer: DaemonConnectionPeer,
    sessionTarget: NativeSessionTarget,
    prompt: string,
): Promise<void> {
    const commandId = randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            kind: "session.prompt",
            requestId: commandId,
            commandId,
            requestId: commandId,
            target: sessionTarget,
            attachments: [],
            prompt,
            disposition: SessionPromptDisposition.Append,
        }),
    );
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (event.type !== "lifecycle-metadata" || !("commandId" in event.payload)) {
            continue;
        }
        if (event.payload.commandId !== commandId) {
            continue;
        }
        if (event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        }
        if (event.payload.kind === "prompt.completed") {
            expect(event.payload.stopReason).toBe("end_turn");
            return;
        }
    }
}

async function historyInMorty(peer: DaemonConnectionPeer, sessionTarget: NativeSessionTarget): Promise<string> {
    const requestId = randomUUID();
    peer.send(
        encodeSessionHistoryPageLoad({
            kind: "session.live-history.v2.page.load",
            requestId,
            target: sessionTarget,
            cursor: null,
            eventLimit: 200,
        }),
    );
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (
            kind === "session.live-history.v2.page.loaded" &&
            decodeSessionHistoryPageLoaded(message).requestId === requestId
        ) {
            return message;
        }
    }
}

test.each(["claude", "pi"] as const)(
    "Given a real %s Session alternates between its terminal and Morty, When either side continues it, Then each side shows and sends every earlier message",
    async (harness) => {
        const conversations: string[] = [];
        const definition = agents[harness];
        const { provider, agent, specification } = await definition.start(conversations);
        await using _provider = provider;
        await using _agent = agent;
        const sessionId = randomUUID();
        // Agents also send auxiliary requests, such as titles, that carry only the newest message.
        const sentWith = (marker: string): readonly string[] =>
            conversations.filter((conversation) => conversation.includes(marker));

        await withRealDaemonConnection(specification, agent.environment, async (peer) => {
            const terminal = async (prompt: string, first = false): Promise<void> =>
                await continueInTerminal(
                    agent.executable,
                    definition.terminal(sessionId, first),
                    prompt,
                    peer.workspace,
                    agent.environment,
                );

            await terminal("TERMINAL_ONE reply without tools", true);
            const sessionTarget = await importRealSession(peer, harness, sessionId);
            await promptFromMorty(peer, sessionTarget, "MORTY_TWO reply without tools");
            await terminal("TERMINAL_THREE reply without tools");
            expect(sentWith("TERMINAL_THREE").some((conversation) => conversation.includes("MORTY_TWO"))).toBe(true);

            // Morty's idle process loaded the conversation before the terminal continued it.
            expect(await historyInMorty(peer, sessionTarget)).toContain("TERMINAL_THREE");
            await promptFromMorty(peer, sessionTarget, "MORTY_FOUR reply without tools");
            expect(sentWith("MORTY_FOUR").some((conversation) => conversation.includes("TERMINAL_THREE"))).toBe(true);

            await terminal("TERMINAL_FIVE reply without tools");
            expect(sentWith("TERMINAL_FIVE").some((conversation) => conversation.includes("MORTY_FOUR"))).toBe(true);
        });
    },
);
