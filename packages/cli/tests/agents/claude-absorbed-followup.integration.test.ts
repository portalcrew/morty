import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    encodeNativeSessionCommand,
    encodeSessionPromptCommand,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { selectSubagentDispatchTool } from "../support/llm/scenarios.ts";

type JsonObject = Readonly<Record<string, unknown>>;
const rootPrompt = "Start the background verification";
const helperPrompt = "Run the isolated background check";
const absorbedPrompt = "Include this new request in the background followup";
const nextPrompt = "Run the next independent request";

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function respond(response: ServerResponse, model: string, content: JsonObject, stream: boolean): void {
    const tool = content["type"] === "tool_use";
    const message = {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model,
        content: [content],
        stop_reason: tool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 6 },
    };
    if (!stream) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message));
        return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, payload: JsonObject) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    event("message_start", {
        message: { ...message, content: [], stop_reason: null },
    });
    event("content_block_start", {
        index: 0,
        content_block: tool ? { ...content, input: {} } : { type: "text", text: "" },
    });
    event("content_block_delta", {
        index: 0,
        delta: tool
            ? { type: "input_json_delta", partial_json: JSON.stringify(content["input"]) }
            : { type: "text_delta", text: content["text"] },
    });
    event("content_block_stop", { index: 0 });
    event("message_delta", {
        delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 6 },
    });
    event("message_stop", {});
    response.end();
}

test("Given Claude is answering a background notification, When it absorbs a new user prompt, Then that prompt completes and the next prompt can run", async () => {
    const mainEntered = Promise.withResolvers<void>();
    const subagentEntered = Promise.withResolvers<void>();
    const followupEntered = Promise.withResolvers<void>();
    const releaseMain = Promise.withResolvers<void>();
    const releaseSubagent = Promise.withResolvers<void>();
    const releaseFollowup = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<never>();
    void failed.promise.catch(() => undefined);
    const model = "claude-sonnet-4-6";
    const server = createServer(async (request, response) => {
        const disconnected = new AbortController();
        response.once("close", () => disconnected.abort());
        const wait = async (gate: Promise<void>) => {
            const closed = Promise.withResolvers<void>();
            const abort = () => closed.resolve();
            disconnected.signal.addEventListener("abort", abort, { once: true });
            try {
                if (!disconnected.signal.aborted) {
                    await Promise.race([gate, closed.promise]);
                }
            } finally {
                disconnected.signal.removeEventListener("abort", abort);
            }
        };
        try {
            if (request.url?.endsWith("/messages/count_tokens")) {
                response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
                return;
            }
            let body = "";
            for await (const chunk of request) {
                body += chunk.toString();
            }
            const decoded: unknown = body.length === 0 ? {} : JSON.parse(body);
            if (!isObject(decoded) || !Array.isArray(decoded["messages"])) {
                response.writeHead(200, { "content-type": "application/json" }).end("{}");
                return;
            }
            const conversation = JSON.stringify(decoded["messages"]);
            let content: JsonObject;
            if (!conversation.includes(rootPrompt) && conversation.includes(helperPrompt)) {
                subagentEntered.resolve();
                await wait(releaseSubagent.promise);
                content = { type: "text", text: "BACKGROUND_CHECK_DONE" };
            } else if (!conversation.includes(rootPrompt)) {
                content = { type: "text", text: "AUXILIARY_REPLY" };
            } else if (!conversation.includes("toolu_background_check")) {
                const tools = Array.isArray(decoded["tools"])
                    ? decoded["tools"].flatMap((tool: unknown) =>
                          isObject(tool) && typeof tool["name"] === "string" ? [{ name: tool["name"] }] : [],
                      )
                    : [];
                const dispatch = selectSubagentDispatchTool(tools);
                if (dispatch === undefined) {
                    // Claude also sends auxiliary requests containing the prompt
                    // (for example, a title); they do not expose Agent tools.
                    respond(response, model, { type: "text", text: "AUXILIARY_REPLY" }, decoded["stream"] === true);
                    return;
                }
                content = {
                    type: "tool_use",
                    id: "toolu_background_check",
                    name: dispatch.name,
                    input: {
                        description: "Background verification",
                        subagent_type: "general-purpose",
                        run_in_background: true,
                        prompt: helperPrompt,
                    },
                };
            } else if (conversation.includes(nextPrompt)) {
                content = { type: "text", text: "NEXT_REQUEST_DONE" };
            } else if (conversation.includes(absorbedPrompt)) {
                content = { type: "text", text: "ABSORBED_REQUEST_DONE" };
            } else if (conversation.includes("<task-notification>")) {
                followupEntered.resolve();
                await wait(releaseFollowup.promise);
                // A real tool boundary lets Claude consume the queued user input.
                // Keep doing harmless work until the model receives that input;
                // no sleep or assumption about subprocess scheduling is needed.
                content = {
                    type: "tool_use",
                    id: `toolu_${randomUUID()}`,
                    name: "Bash",
                    input: { command: "printf FOLLOWUP_BOUNDARY", description: "Verify the followup" },
                };
            } else {
                mainEntered.resolve();
                await wait(releaseMain.promise);
                content = { type: "text", text: "MAIN_REQUEST_DONE" };
            }
            respond(response, model, content, decoded["stream"] === true);
        } catch (error) {
            failed.reject(error);
            response.destroy();
        }
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
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
        await writeFile(
            join(config, "settings.json"),
            JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
        );
        await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
            const abort = () => failed.reject(peer.signal.reason);
            peer.signal.addEventListener("abort", abort, { once: true });
            const wait = <T>(promise: Promise<T>) => Promise.race([promise, failed.promise]);
            const completed = new Map<string, string>();
            const started = new Set<string>();
            let backgroundFinished = false;
            let text = "";
            const send = (commandId: string, prompt: string) =>
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        commandId,
                        requestId: commandId,
                        prompt,
                        target: peer.target,
                        attachments: [],
                        disposition: "append",
                    }),
                );
            const next = async () => {
                const message = await wait(peer.nextMessage());
                if (decodeMessageKind(message) === "session.operation.failed") {
                    throw new Error(message);
                }
                if (decodeMessageKind(message) === "session.event.v2") {
                    for (const event of decodeSessionEventEnvelope(message).events) {
                        if (event.type === "lifecycle-metadata") {
                            if (event.payload.kind === "prompt.failed") {
                                throw new Error(JSON.stringify(event.payload));
                            }
                            if (event.payload.kind === "prompt.started") {
                                started.add(event.payload.commandId);
                            }
                            if (event.payload.kind === "prompt.completed") {
                                completed.set(event.payload.commandId, event.payload.stopReason);
                            }
                        } else if (event.type === "acp") {
                            if (
                                (event.payload.sessionUpdate === "tool_call" ||
                                    event.payload.sessionUpdate === "tool_call_update") &&
                                event.payload.backgroundTask?.status === "completed"
                            ) {
                                backgroundFinished = true;
                            }
                            if (
                                event.payload.sessionUpdate === "agent_message_chunk" &&
                                event.payload.content.type === "text"
                            ) {
                                text += event.payload.content.text;
                            }
                        }
                    }
                }
                return message;
            };
            const assertIdle = async () => {
                const requestId = randomUUID();
                peer.send(
                    encodeNativeSessionCommand({
                        kind: "native.session.request",
                        action: "active-turn",
                        requestId,
                        target: peer.target,
                    }),
                );
                for (;;) {
                    const message = await next();
                    if (decodeMessageKind(message) !== "native.session.result") {
                        continue;
                    }
                    const result = decodeNativeSessionResult(message);
                    if (result.requestId !== requestId || result.action !== "active-turn") {
                        continue;
                    }
                    expect(result.turn).toBeNull();
                    expect(result.queued).toEqual([]);
                    return;
                }
            };
            try {
                const main = randomUUID();
                send(main, rootPrompt);
                while (!started.has(main)) {
                    await next();
                }
                await wait(Promise.all([mainEntered.promise, subagentEntered.promise]));
                releaseSubagent.resolve();
                while (!backgroundFinished) {
                    await next();
                }
                releaseMain.resolve();
                while (!completed.has(main)) {
                    await next();
                }
                expect(completed.get(main)).toBe("end_turn");
                await wait(followupEntered.promise);
                const absorbed = randomUUID();
                send(absorbed, absorbedPrompt);
                while (!started.has(absorbed)) {
                    await next();
                }
                releaseFollowup.resolve();
                while (!completed.has(absorbed)) {
                    await next();
                }
                expect(completed.get(absorbed)).toBe("end_turn");
                expect(text).toContain("ABSORBED_REQUEST_DONE");
                await assertIdle();
                const following = randomUUID();
                send(following, nextPrompt);
                while (!completed.has(following)) {
                    await next();
                }
                expect(completed.get(following)).toBe("end_turn");
                expect(text).toContain("NEXT_REQUEST_DONE");
                await assertIdle();
            } catch (cause) {
                throw new Error(JSON.stringify({ started: [...started], completed: [...completed], text }), { cause });
            } finally {
                peer.signal.removeEventListener("abort", abort);
                releaseMain.resolve();
                releaseSubagent.resolve();
                releaseFollowup.resolve();
            }
        });
    } finally {
        releaseMain.resolve();
        releaseSubagent.resolve();
        releaseFollowup.resolve();
        server.closeAllConnections();
        if (server.listening) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
});
