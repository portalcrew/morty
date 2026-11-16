import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { readAgentName } from "../../support/acp-process.ts";
import { sessionConfiguration } from "./acp-session-settings.ts";
import { acquireWriter, nativeHistory, readRecoveredState, sessions } from "./acp-session-state.ts";

const replayedSessionHistory = new Set<string>();

export function oversizedHistoryUpdate(toolCallId: string) {
    const image = {
        data: Buffer.concat([
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
            ),
            Buffer.alloc(750_000),
        ]).toString("base64"),
        mimeType: "image/png",
        type: "image" as const,
    };
    return {
        content: [
            {
                type: "content" as const,
                content: {
                    type: "text" as const,
                    text: JSON.stringify({ result: { content: [{ type: "text", text: "Generated image" }, image] } }),
                },
            },
            { type: "content" as const, content: image },
            {
                type: "content" as const,
                content: { data: "AQIDBA==", mimeType: "audio/wav", type: "audio" as const },
            },
            {
                type: "content" as const,
                content: {
                    resource: {
                        mimeType: "text/plain",
                        text: "Generated resource",
                        uri: "resource:///generated.txt",
                    },
                    type: "resource" as const,
                },
            },
        ],
        rawOutput: { result: { content: [{ type: "text", text: "Generated image" }, image] } },
        sessionUpdate: "tool_call_update" as const,
        toolCallId,
    };
}

export function registerHistory(agent: ReturnType<typeof acp.agent>) {
    return agent.onRequest(acp.methods.agent.session.load, async (context) => {
        if (process.env["MORTY_FAKE_ACP_FAIL_HISTORY_LOAD"] === "1") {
            throw acp.RequestError.internalError({
                details: "Native history unavailable in the current working directory",
            });
        }
        acquireWriter(context.params.sessionId);
        const directory = process.env["MORTY_FAKE_ACP_STATE_DIRECTORY"];
        if (directory !== undefined && existsSync(join(directory, "interactions-during-preview"))) {
            const requests = [
                async () =>
                    await context.client.request(acp.methods.client.session.requestPermission, {
                        sessionId: context.params.sessionId,
                        toolCall: { toolCallId: "preview-read", title: "Read saved history" },
                        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
                    }),
                async () =>
                    await context.client.request(acp.methods.client.elicitation.create, {
                        sessionId: context.params.sessionId,
                        mode: "form",
                        message: "Provide input for preview",
                        requestedSchema: { type: "object", properties: {} },
                    }),
            ];
            for (const request of requests) {
                let text = "Preview interaction unexpectedly accepted";
                try {
                    await request();
                } catch {
                    text = "Preview interaction rejected";
                }
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: randomUUID(),
                        content: { type: "text", text },
                    },
                });
            }
        }
        const pausePath = directory === undefined ? null : join(directory, "pause-load");
        const pauseTarget = pausePath !== null && existsSync(pausePath) ? readFileSync(pausePath, "utf8").trim() : null;
        if (
            directory !== undefined &&
            (pauseTarget === "" || pauseTarget === "*" || pauseTarget === context.params.sessionId)
        ) {
            writeFileSync(join(directory, "load-paused"), context.params.sessionId);
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    sessionUpdate: "session_info_update",
                    title: "Loading saved conversation",
                },
            });
            await new Promise<void>((resolve, reject) => {
                const watcher = watch(directory, () => {
                    if (!existsSync(join(directory, "pause-load"))) {
                        cleanup();
                        resolve();
                    }
                });
                const abort = () => {
                    cleanup();
                    reject(context.signal.reason);
                };
                const cleanup = () => {
                    watcher.close();
                    context.signal.removeEventListener("abort", abort);
                };
                context.signal.addEventListener("abort", abort, { once: true });
                if (!existsSync(join(directory, "pause-load"))) {
                    cleanup();
                    resolve();
                }
            });
            context.signal.throwIfAborted();
        }
        const state = readRecoveredState(context.params.sessionId);
        sessions.set(context.params.sessionId, state);
        const history =
            process.argv.includes("--replay-history-once") && replayedSessionHistory.has(context.params.sessionId)
                ? []
                : (nativeHistory.get(context.params.sessionId) ?? []);
        replayedSessionHistory.add(context.params.sessionId);
        for (const message of history) {
            if (message.role === "assistant") {
                const replayId = message.messageId;
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        content: { text: "Inspecting the workspace", type: "text" },
                        messageId: `reasoning-${replayId}`,
                        sessionUpdate: "agent_thought_chunk",
                    },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        kind: "read",
                        locations: [{ path: `${process.cwd()}/package.json` }],
                        name: "read_file",
                        rawInput: { path: "package.json" },
                        sessionUpdate: "tool_call",
                        status: "in_progress",
                        title: "Read package metadata",
                        toolCallId: `tool-${replayId}`,
                    },
                });
                if (process.env["MORTY_FAKE_ACP_OVERSIZED_HISTORY_IMAGE"] === "1") {
                    await context.client.notify(acp.methods.client.session.update, {
                        sessionId: context.params.sessionId,
                        update: oversizedHistoryUpdate(`tool-${replayId}`),
                    });
                }
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        rawOutput: process.argv.includes("--large-replay-activity")
                            ? { output: "x".repeat(100_000) }
                            : { name: "morty-workspace" },
                        sessionUpdate: "tool_call_update",
                        status: "completed",
                        toolCallId: `tool-${replayId}`,
                    },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        kind: "other",
                        name: "agent_error",
                        rawInput: {},
                        sessionUpdate: "tool_call",
                        status: "in_progress",
                        title: "Agent error",
                        toolCallId: `error-${replayId}`,
                    },
                });
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        rawOutput: "Agent could not inspect the optional workspace file",
                        sessionUpdate: "tool_call_update",
                        status: "failed",
                        toolCallId: `error-${replayId}`,
                    },
                });
            }
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
                    content: { type: "text", text: message.text },
                    messageId: message.messageId,
                },
            });
            for (const image of message.images ?? []) {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        sessionUpdate: "user_message_chunk",
                        messageId: message.messageId,
                        content:
                            readAgentName() === "Codex"
                                ? {
                                      type: "text",
                                      text: `[@image](data:${image.mimeType};base64,${image.data})`,
                                  }
                                : { type: "image", ...image },
                    },
                });
            }
        }
        return sessionConfiguration(state);
    });
}
