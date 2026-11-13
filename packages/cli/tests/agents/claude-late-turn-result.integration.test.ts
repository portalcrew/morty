import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

type JsonObject = Readonly<Record<string, unknown>>;
const firstPrompt = "FIRST_PROMPT please answer";
const secondPrompt = "SECOND_PROMPT please answer";

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A non-streaming gateway: a JSON body even for stream requests. Claude then yields
// the assistant message with stop_reason end_turn ahead of its result.
function answer(response: ServerResponse, model: string, text: string): void {
    response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
            id: randomUUID(),
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 6 },
        }),
    );
}

// @no-uc: A turn the adapter settled before its result (here the result watchdog, while a slow Stop hook delays
// the result) must absorb that late result; it must not settle the next prompt before that prompt answers.
test("Given Claude's Stop hook outlasts the result watchdog, When I send the next prompt before the first turn's late result, Then the next prompt completes with its own answer", {
    timeout: 240_000,
}, async () => {
    const model = "claude-sonnet-4-6";
    const stopHook = Promise.withResolvers<void>();
    const heldHooks: ServerResponse[] = [];
    let hooksReleased = false;
    const server = createServer(async (request, response) => {
        if (request.url === "/stop-hook") {
            request.resume();
            stopHook.resolve();
            if (hooksReleased) {
                response.writeHead(200).end();
            } else {
                heldHooks.push(response);
            }
            return;
        }
        if (request.url?.endsWith("/messages/count_tokens")) {
            request.resume();
            response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
            return;
        }
        let body = "";
        for await (const chunk of request) {
            body += chunk.toString();
        }
        const decoded: unknown = body.length === 0 ? {} : JSON.parse(body);
        const conversation = isObject(decoded) ? JSON.stringify(decoded["messages"] ?? "") : "";
        answer(
            response,
            model,
            conversation.includes("SECOND_PROMPT")
                ? "SECOND_ANSWER"
                : conversation.includes("FIRST_PROMPT")
                  ? "FIRST_ANSWER"
                  : "AUXILIARY_REPLY",
        );
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const releaseHooks = () => {
        hooksReleased = true;
        for (const response of heldHooks.splice(0)) {
            response.writeHead(200).end();
        }
    };
    try {
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("The model provider has no TCP address");
        }
        await using agent = await ClaudeFixture.create({ origin: `http://127.0.0.1:${address.port}`, model });
        const config = agent.environment["CLAUDE_CONFIG_DIR"];
        if (config === undefined) {
            throw new Error("Missing isolated Claude configuration");
        }
        await mkdir(config, { recursive: true });
        // A user Stop hook that runs until the test releases it, like a "run the tests
        // before finishing" hook taking longer than the adapter's result watchdog.
        const hook = join(config, "stop-hook.mjs");
        await writeFile(
            hook,
            `for await (const _ of process.stdin) {}\nawait fetch(${JSON.stringify(`http://127.0.0.1:${address.port}/stop-hook`)});\n`,
        );
        await writeFile(
            join(config, "settings.json"),
            JSON.stringify({
                permissions: { defaultMode: "bypassPermissions" },
                hooks: {
                    Stop: [
                        {
                            hooks: [
                                {
                                    type: "command",
                                    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`,
                                    timeout: 300,
                                },
                            ],
                        },
                    ],
                },
            }),
        );
        await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
            const send = (commandId: string, prompt: string) =>
                peer.send(
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: commandId,
                        disposition: SessionPromptDisposition.Append,
                        attachments: [],
                        kind: "session.prompt",
                        prompt,
                        target: peer.target,
                    }),
                );
            let answers = "";
            let submitted = "";
            /** Reads the next live event, recording delivered text; returns its lifecycle payload. */
            const next = async () => {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "acp") {
                    const update = event.payload;
                    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                        answers += update.content.text;
                    } else if (update.sessionUpdate === "user_message_chunk" && update.content.type === "text") {
                        submitted += update.content.text;
                    }
                    return undefined;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    throw new Error(`Prompt ${event.payload.commandId} failed: ${event.payload.code}`);
                }
                return event.type === "lifecycle-metadata" ? event.payload : undefined;
            };
            const completion = async (commandId: string) => {
                for (;;) {
                    const lifecycle = await next();
                    if (lifecycle?.kind === "prompt.completed" && lifecycle.commandId === commandId) {
                        return { stopReason: lifecycle.stopReason, answers };
                    }
                }
            };
            const untilSubmitted = async (prompt: string) => {
                while (!submitted.includes(prompt)) {
                    await next();
                }
            };

            try {
                // The first turn answers, then its Stop hook keeps the result back past
                // the adapter's watchdog, which settles the prompt on its own.
                const first = randomUUID();
                send(first, firstPrompt);
                const firstCompletion = await completion(first);
                await stopHook.promise;
                expect(firstCompletion).toEqual({ stopReason: "end_turn", answers: "FIRST_ANSWER" });

                // The next prompt reaches Claude while the first turn's hook still runs;
                // only then does the first turn produce its late result.
                const second = randomUUID();
                send(second, secondPrompt);
                await untilSubmitted(secondPrompt);
                releaseHooks();

                expect(await completion(second)).toEqual({
                    stopReason: "end_turn",
                    answers: "FIRST_ANSWERSECOND_ANSWER",
                });
            } finally {
                releaseHooks();
            }
        });
    } finally {
        releaseHooks();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
});
