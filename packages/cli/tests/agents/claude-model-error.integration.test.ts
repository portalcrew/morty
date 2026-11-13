import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
    decodeSessionLiveEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

// @no-uc: A typed provider failure must settle the public prompt lifecycle, even without a result trailer.
test("Given Claude receives a model-not-found response, When I send a prompt, Then it fails without treating the diagnostic as an answer", async () => {
    const server = createServer((request, response) => {
        request.resume();
        if (request.url?.includes("count_tokens")) {
            response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
        } else {
            response.writeHead(404, { "content-type": "application/json" }).end(
                JSON.stringify({
                    type: "error",
                    error: { type: "not_found_error", message: "model: claude-sonnet-4-6" },
                }),
            );
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected a provider port");
        }
        await using agent = await ClaudeFixture.create({
            origin: `http://127.0.0.1:${address.port}`,
            model: "claude-sonnet-4-6",
        });
        await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    requestId: commandId,
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "Answer this request",
                    target: peer.target,
                }),
            );
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk") {
                    throw new Error("A model API error must not be delivered as an answer");
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    throw new Error("A model API error must not succeed");
                }
                if (
                    event.type === "lifecycle-metadata" &&
                    (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                ) {
                    expect(event.payload.commandId).toBe(commandId);
                    expect(event.payload.code).toBe("acp_agent_error");
                    break;
                }
            }
        });
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
});
