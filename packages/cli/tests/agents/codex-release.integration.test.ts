import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    type NativeSessionTarget,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import {
    type DaemonConnectionPeer,
    importRealSession,
    withRealDaemonConnection,
} from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

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
        if (
            event.type !== "lifecycle-metadata" ||
            !("commandId" in event.payload) ||
            event.payload.commandId !== commandId
        ) {
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

async function continueInTerminal(fixture: CodexFixture, cwd: string, args: readonly string[]): Promise<string> {
    const terminal = spawn(fixture.executable, ["exec", "--skip-git-repo-check", "--json", ...args], {
        cwd,
        env: { ...process.env, ...fixture.environment },
        signal: AbortSignal.timeout(120_000),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    terminal.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    terminal.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
        terminal.once("error", reject);
        terminal.once("close", resolve);
    });
    expect(code, output).toBe(0);
    return output;
}

test("Given Morty continued a real Codex Session, When the user runs morty release, Then the Codex terminal continues it and Morty sees that turn next", async () => {
    const conversations: string[] = [];
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "RELEASE_REPLY", {
        beforeFirstText: async (_signal, conversation) => {
            conversations.push(conversation);
        },
    });
    await using fixture = await CodexFixture.create(provider);
    const sentWith = (marker: string): readonly string[] =>
        conversations.filter((conversation) => conversation.includes(marker));
    await withRealDaemonConnection(
        new CodexAgentSpecification(),
        fixture.environment,
        async (peer) => {
            const started = await continueInTerminal(fixture, peer.workspace, ["TERMINAL_ONE reply without tools"]);
            const sessionId = /"thread_id":"([0-9a-f-]{36})"/u.exec(started)?.[1];
            if (sessionId === undefined) {
                throw new Error(`Codex did not report its thread: ${started}`);
            }
            const sessionTarget = await importRealSession(peer, "codex", sessionId);
            await promptFromMorty(peer, sessionTarget, "MORTY_TWO reply without tools");

            // Codex admits one writer per thread, so resuming fails while Morty's idle process holds it.
            await peer.cli(["release"]);
            await continueInTerminal(fixture, peer.workspace, [
                "resume",
                sessionId,
                "TERMINAL_THREE reply without tools",
            ]);
            expect(sentWith("TERMINAL_THREE").some((conversation) => conversation.includes("MORTY_TWO"))).toBe(true);

            await promptFromMorty(peer, sessionTarget, "MORTY_FOUR reply without tools");
            expect(sentWith("MORTY_FOUR").some((conversation) => conversation.includes("TERMINAL_THREE"))).toBe(true);
        },
        "managed",
    );
});
