import * as acp from "@agentclientprotocol/sdk/unstable";

export async function publishContentScenario(
    context: acp.AgentRequestContext<acp.PromptRequest>,
    prompt: string,
    turnNumber: number,
    toolCallId: string,
): Promise<void> {
    if (prompt === "advertise commands") {
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                availableCommands: [
                    {
                        description: "Review the current workspace",
                        input: { hint: "optional focus" },
                        name: "review",
                    },
                    ...(process.argv.includes("--advertise-compact-command")
                        ? [
                              {
                                  description: "Compact the current conversation",
                                  name: "compact",
                              },
                          ]
                        : []),
                ],
                sessionUpdate: "available_commands_update",
            },
        });
    }

    if (prompt === "exercise ACP controls") {
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                availableCommands: [
                    {
                        description: "Review the current workspace",
                        input: { hint: "optional focus" },
                        name: "review",
                    },
                ],
                sessionUpdate: "available_commands_update",
            },
        });
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                sessionUpdate: "session_info_update",
                title: "ACP feature session",
                updatedAt: "2026-09-04T00:00:00.000Z",
            },
        });
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                sessionUpdate: "session_info_update",
                updatedAt: "2026-09-04T00:01:00.000Z",
            },
        });
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                cost: { amount: 0.125, currency: "USD" },
                sessionUpdate: "usage_update",
                size: 200_000,
                used: 50_000,
            },
        });
    }

    if (prompt === "interleave untagged progress" || prompt === "interleave progress and hold") {
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                content: {
                    text: "Checking the workspace",
                    type: "text",
                },
                messageId: `intermediate-${turnNumber.toString()}-1`,
                sessionUpdate: "agent_message_chunk",
            },
        });
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                content: {
                    text: "Preparing the next tool call",
                    type: "text",
                },
                messageId: `intermediate-${turnNumber.toString()}-2`,
                sessionUpdate: "agent_message_chunk",
            },
        });
    }

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
            toolCallId,
        },
    });
    if (prompt === "stream cumulative tool output") {
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                rawOutput: { output: "first snapshot" },
                sessionUpdate: "tool_call_update",
                status: "in_progress",
                toolCallId,
            },
        });
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                content: [{ content: { text: "rendered snapshot", type: "text" }, type: "content" }],
                sessionUpdate: "tool_call_update",
                toolCallId,
            },
        });
    }
    await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
            content:
                prompt === "exercise ACP controls"
                    ? [
                          {
                              newText: "const feature = true;\n",
                              oldText: "const feature = false;\n",
                              path: `${process.cwd()}/feature.ts`,
                              type: "diff",
                          },
                          {
                              content: {
                                  resource: {
                                      mimeType: "text/plain",
                                      text: "structured tool result",
                                      uri: "resource:///tool-result.txt",
                                  },
                                  type: "resource",
                              },
                              type: "content",
                          },
                      ]
                    : prompt === "generate inline image" || prompt === "generate inline image with reused tool id"
                      ? [
                            {
                                content: {
                                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                                    mimeType: "image/png",
                                    type: "image",
                                },
                                type: "content",
                            },
                        ]
                      : undefined,
            rawOutput:
                prompt === "return oversized tool output"
                    ? "x".repeat(500_001)
                    : prompt === "stream cumulative tool output"
                      ? { output: "final snapshot" }
                      : { name: "morty-workspace" },
            sessionUpdate: "tool_call_update",
            status: "completed",
            toolCallId,
        },
    });
}
