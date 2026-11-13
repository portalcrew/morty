import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    encodeSessionCancelCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.each(["foreground", "background"] as const)(
    "Given a real Codex %s command awaits a write, When the user stops the turn, Then it cannot write and the conversation can continue",
    async (phase) => {
        const connected = Promise.withResolvers<Socket>();
        const effect = Promise.withResolvers<"written" | "closed">();
        const sockets = new Set<Socket>();
        const gate = createServer((socket) => {
            sockets.add(socket);
            socket.on("data", () => effect.resolve("written"));
            socket.once("close", () => {
                sockets.delete(socket);
                effect.resolve("closed");
            });
            connected.resolve(socket);
        });
        await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
        const address = gate.address();
        if (address === null || typeof address === "string") {
            throw new Error("The command gate did not open");
        }
        const script = `const socket = require('node:net').connect(${address.port}, '127.0.0.1'); socket.once('data', () => { require('node:fs').writeFileSync('cancelled-command.txt', 'written'); socket.end('written'); });`;
        const command = `node -e ${JSON.stringify(script)}`;
        const providerEntered = Promise.withResolvers<void>();
        let hold = true;
        await using provider = await FakeOpenAiProvider.start("morty-test-model", "CONTINUED_AFTER_STOP", {
            toolPrompt: "Start the gated command",
            toolSequence: [
                {
                    name: "exec",
                    input: `const result = await tools.exec_command({cmd: ${JSON.stringify(command)}, yield_time_ms: 1000}); text(result);`,
                },
            ],
            beforeFirstText: async (signal) => {
                if (!hold) {
                    return;
                }
                providerEntered.resolve();
                if (!signal.aborted) {
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), { once: true }),
                    );
                }
            },
        });
        await using codex = await CodexFixture.create(provider);
        try {
            await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
                const prompt = (text: string): string => {
                    const commandId = randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            commandId,
                            requestId: commandId,
                            disposition: SessionPromptDisposition.Append,
                            attachments: [],
                            kind: "session.prompt",
                            prompt: text,
                            target: peer.target,
                            ...(text === "Start the gated command"
                                ? {
                                      sessionConfigurations: [
                                          {
                                              configId: "reasoning_effort",
                                              type: "select",
                                              value: "high",
                                          },
                                      ],
                                  }
                                : {}),
                        }),
                    );
                    return commandId;
                };
                const commandId = prompt("Start the gated command");
                const socket = await connected.promise;
                if (phase === "background") {
                    await providerEntered.promise;
                }
                hold = false;
                peer.send(
                    encodeSessionCancelCommand({
                        kind: "session.cancel",
                        requestId: crypto.randomUUID(),
                        commandId,
                        target: peer.target,
                    }),
                );
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type !== "lifecycle-metadata") {
                        continue;
                    }
                    if (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start") {
                        throw new Error(JSON.stringify(event));
                    }
                    if (event.payload.kind === "prompt.completed" && event.payload.commandId === commandId) {
                        expect(event.payload.stopReason).toBe("cancelled");
                        break;
                    }
                }
                if (!socket.destroyed) {
                    socket.write("commit");
                }
                expect(await effect.promise).toBe("closed");
                await expect(readFile(join(peer.workspace, "cancelled-command.txt"))).rejects.toMatchObject({
                    code: "ENOENT",
                });
                const next = prompt("Continue our conversation");
                let text = "";
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        text += event.payload.content.text;
                    }
                    if (event.type !== "lifecycle-metadata") {
                        continue;
                    }
                    if (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start") {
                        throw new Error(JSON.stringify(event));
                    }
                    if (event.payload.kind === "prompt.completed" && event.payload.commandId === next) {
                        break;
                    }
                }
                expect(text).toContain("CONTINUED_AFTER_STOP");
                expect(provider.diagnostics().at(-1)).toMatchObject({ reasoning: { effort: "high" } });
                peer.send(
                    encodeSessionHistoryPageLoad({
                        kind: "session.live-history.v2.page.load",
                        requestId: randomUUID(),
                        target: peer.target,
                        cursor: null,
                        eventLimit: 200,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                        continue;
                    }
                    const history = decodeSessionHistoryPageLoaded(message)
                        .events.events.events.flatMap((event) =>
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "user_message_chunk" &&
                            event.payload.content.type === "text"
                                ? [event.payload.content.text]
                                : [],
                        )
                        .join("\n");
                    expect(history).toContain("Start the gated command");
                    expect(history).toContain("Continue our conversation");
                    break;
                }
            });
        } finally {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => gate.close(() => resolve()));
        }
    },
);
