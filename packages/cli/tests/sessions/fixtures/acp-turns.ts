import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { countPromptBlock, isRecord, readAgentName, readPromptText, waitForAbort } from "../../support/acp-process.ts";
import { publishContentScenario } from "./acp-content.ts";
import { runInteractionScenario } from "./acp-interactions.ts";
import { oversizedHistoryUpdate } from "./acp-native-history.ts";
import {
    nativeHistory,
    nativeMetadata,
    persistState,
    releaseWriter,
    sessions,
    steeringWaiters,
    turnCancellations,
} from "./acp-session-state.ts";
import { runStreamingScenario } from "./acp-streaming.ts";
import { publishUsage, usageResponse } from "./acp-usage.ts";

const agentName = readAgentName();
export function registerTurns(agent: ReturnType<typeof acp.agent>) {
    return agent
        .onRequest(
            "_session/steering",
            (params: unknown) => params,
            async (context) => {
                if (!isRecord(context.params)) {
                    throw new Error("Invalid steering request");
                }
                const sessionId = context.params["sessionId"];
                if (typeof sessionId !== "string") {
                    throw new Error("Invalid steering session");
                }
                const waiter = steeringWaiters.get(sessionId);
                if (waiter === undefined) {
                    return { outcome: "promptRequired", reason: "noRunningTurn" };
                }
                const messageId = `steer-${crypto.randomUUID()}`;
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId,
                    update: {
                        sessionUpdate: "user_message_chunk",
                        messageId,
                        content: { type: "text", text: readPromptText(context.params["prompt"]) },
                    },
                });
                waiter.resolve(readPromptText(context.params["prompt"]));
                return { outcome: "injected", messageId };
            },
        )
        .onRequest(acp.methods.agent.session.prompt, async (context) => {
            const previousState = sessions.get(context.params.sessionId);
            if (previousState === undefined) {
                throw new Error("Unknown ACP session");
            }
            const turnNumber = previousState.turnCount + 1;
            const messageId = `user-${turnNumber.toString()}`;
            for (const content of context.params.prompt) {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: { sessionUpdate: "user_message_chunk", messageId, content },
                });
            }
            const respond = async (): Promise<acp.PromptResponse> => {
                context.signal.throwIfAborted();
                const prompt = readPromptText(context.params.prompt);
                const transcript = nativeHistory.get(context.params.sessionId) ?? [];
                transcript.push({
                    messageId: `user-${turnNumber.toString()}`,
                    role: "user",
                    text: prompt,
                    images: context.params.prompt.flatMap((block) =>
                        block.type === "image" ? [{ data: block.data, mimeType: block.mimeType }] : [],
                    ),
                });
                nativeHistory.set(context.params.sessionId, transcript);
                const state = previousState.withTurnCount(turnNumber);
                sessions.set(context.params.sessionId, state);
                persistState(context.params.sessionId, state);
                if (prompt === "fail with model unavailable") {
                    throw acp.RequestError.internalError(undefined, "Model unavailable: controlled/test-model");
                }
                if (prompt.startsWith("fail echoing the prompt ")) {
                    throw acp.RequestError.internalError(
                        undefined,
                        `Rejected prompt: ${prompt.slice("fail echoing the prompt ".length)}`,
                    );
                }
                if (prompt === "fail with invalid prompt detail") {
                    throw acp.RequestError.internalError({
                        error: {
                            code: "invalid_prompt",
                            message:
                                "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
                            param: null,
                            type: "invalid_request_error",
                        },
                        status: 400,
                        type: "error",
                    });
                }
                if (process.env["MORTY_FAKE_ACP_OVERSIZED_HISTORY_IMAGE"] === "1") {
                    await context.client.notify(acp.methods.client.session.update, {
                        sessionId: context.params.sessionId,
                        update: oversizedHistoryUpdate(`tool-${turnNumber.toString()}`),
                    });
                }
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        sessionUpdate: "session_info_update",
                        updatedAt: "2026-09-05T00:00:00Z",
                    },
                });
                const metadata = nativeMetadata.get(context.params.sessionId);
                if (turnNumber === 1 && metadata !== undefined) {
                    nativeMetadata.set(context.params.sessionId, {
                        ...metadata,
                        title: prompt,
                    });
                }
                persistState(context.params.sessionId, state);
                const cancellation = new AbortController();
                turnCancellations.set(context.params.sessionId, cancellation);
                const steering = Promise.withResolvers<string>();
                if (prompt === "wait for steering") {
                    steeringWaiters.set(context.params.sessionId, steering);
                }
                try {
                    const streamingResult = await runStreamingScenario(
                        context,
                        prompt,
                        turnNumber,
                        cancellation,
                        state,
                        transcript,
                    );
                    if (streamingResult !== undefined) {
                        return streamingResult;
                    }
                    const toolCallId =
                        prompt === "generate inline image with reused tool id"
                            ? "reused-image-tool"
                            : `tool-${turnNumber.toString()}`;

                    await publishUsage(context);
                    await publishContentScenario(context, prompt, turnNumber, toolCallId);
                    if (prompt === "wait for steering") {
                        await context.client.notify(acp.methods.client.session.update, {
                            sessionId: context.params.sessionId,
                            update: {
                                content: {
                                    resource: {
                                        mimeType: "text/plain",
                                        text: "Active structured content",
                                        uri: "resource:///active-content.txt",
                                    },
                                    type: "resource",
                                },
                                messageId: `assistant-${turnNumber.toString()}`,
                                sessionUpdate: "agent_message_chunk",
                            },
                        });
                        const instruction = await steering.promise;
                        if (instruction === "fail with model unavailable") {
                            throw acp.RequestError.internalError(undefined, "Model unavailable: controlled/test-model");
                        }
                        const text = `Steered: ${instruction}`;
                        await context.client.notify(acp.methods.client.session.update, {
                            sessionId: context.params.sessionId,
                            update: {
                                content: { text, type: "text" },
                                messageId: `assistant-${turnNumber.toString()}`,
                                sessionUpdate: "agent_message_chunk",
                            },
                        });
                        transcript.push({ messageId: `assistant-${turnNumber.toString()}`, role: "assistant", text });
                        persistState(context.params.sessionId, state);
                        return { stopReason: "end_turn" };
                    }

                    const interaction = await runInteractionScenario(context, prompt, turnNumber, cancellation);
                    if ("stopReason" in interaction) {
                        return interaction;
                    }
                    const selectedBranch = interaction.branch;
                    const responseText =
                        prompt === "Report working directory"
                            ? process.cwd()
                            : prompt === "Report execution settings"
                              ? `${state.mode} ${state.model} ${state.reasoningEffort} ${state.fastMode ? "fast" : "standard"}`
                              : prompt === "Report prompt blocks"
                                ? `${countPromptBlock(context.params.prompt, "image").toString()} image, ${countPromptBlock(context.params.prompt, "resource").toString()} resource`
                                : prompt === "exercise ACP controls"
                                  ? `${state.mode} ${state.model} ${state.reasoningEffort} ${state.fastMode ? "fast" : "standard"} ${selectedBranch} (${countPromptBlock(context.params.prompt, "image").toString()} image, ${countPromptBlock(context.params.prompt, "resource").toString()} resource)`
                                  : agentName.length === 0
                                    ? "Echo from ACP: "
                                    : `${agentName} turn ${turnNumber.toString()}: `;
                    await context.client.notify(acp.methods.client.session.update, {
                        sessionId: context.params.sessionId,
                        update: {
                            content: {
                                text: responseText,
                                type: "text",
                            },
                            messageId: `assistant-${turnNumber.toString()}`,
                            sessionUpdate: "agent_message_chunk",
                        },
                    });
                    const echoedPrompt =
                        prompt === "generate markdown image" || prompt === "generate media artifacts"
                            ? (() => {
                                  const path = join(
                                      process.env["FAKE_ACP_IMAGE_DIRECTORY"] ?? process.cwd(),
                                      "generated-image.png",
                                  );
                                  writeFileSync(
                                      path,
                                      Buffer.from(
                                          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                                          "base64",
                                      ),
                                  );
                                  return `![Generated image](<${path}> "Generated locally")`;
                              })()
                            : prompt;
                    if (prompt === "generate media artifacts") {
                        await context.client.notify(acp.methods.client.session.update, {
                            sessionId: context.params.sessionId,
                            update: {
                                content: {
                                    resource: {
                                        blob: "AAAAGGZ0eXBpc29tAAACAGlzb21pc28y",
                                        mimeType: "video/mp4",
                                        uri: "file:///generated-video.mp4",
                                    },
                                    type: "resource",
                                },
                                messageId: `assistant-${turnNumber.toString()}`,
                                sessionUpdate: "agent_message_chunk",
                            },
                        });
                    }
                    if (
                        prompt !== "exercise ACP controls" &&
                        prompt !== "Report working directory" &&
                        prompt !== "Report execution settings" &&
                        prompt !== "Report prompt blocks"
                    ) {
                        const chunks =
                            prompt === "generate markdown image"
                                ? [echoedPrompt.slice(0, 2), echoedPrompt.slice(2, -1), echoedPrompt.slice(-1)]
                                : prompt === "stream token burst"
                                  ? Array.from({ length: 64 }, (_value, index) => `token-${index.toString()} `)
                                  : [echoedPrompt];
                        for (const text of chunks) {
                            await context.client.notify(acp.methods.client.session.update, {
                                sessionId: context.params.sessionId,
                                update: {
                                    content: {
                                        text,
                                        type: "text",
                                    },
                                    messageId: `assistant-${turnNumber.toString()}`,
                                    sessionUpdate: "agent_message_chunk",
                                },
                            });
                        }
                    }
                    if (prompt === "interleave progress and hold") {
                        await waitForAbort(cancellation.signal);
                        return { stopReason: "cancelled" };
                    }

                    transcript.push({
                        messageId: `assistant-${turnNumber.toString()}`,
                        role: "assistant",
                        text:
                            responseText +
                            (prompt === "exercise ACP controls" ||
                            prompt === "Report working directory" ||
                            prompt === "Report execution settings" ||
                            prompt === "Report prompt blocks"
                                ? ""
                                : echoedPrompt),
                    });
                    persistState(context.params.sessionId, state);

                    return usageResponse();
                } finally {
                    turnCancellations.delete(context.params.sessionId);
                    steeringWaiters.delete(context.params.sessionId);
                }
            };
            try {
                const response = await respond();
                return { ...response, _meta: { ...response._meta, messageId } };
            } catch (cause) {
                if (cause instanceof acp.RequestError) {
                    const data = typeof cause.data === "object" && cause.data !== null ? cause.data : {};
                    cause.data = { ...data, messageId };
                }
                throw cause;
            }
        })
        .onNotification(acp.methods.agent.session.cancel, (context) => {
            turnCancellations.get(context.params.sessionId)?.abort();
        })
        .onRequest(acp.methods.agent.session.close, (context) => {
            sessions.delete(context.params.sessionId);
            releaseWriter(context.params.sessionId);
            return {};
        });
}
