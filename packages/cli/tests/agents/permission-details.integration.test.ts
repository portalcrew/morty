import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    encodeNativeSessionCommand,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.each(["allow_once", "reject_once"] as const)(
    "Given real Codex requests command approval, When the user selects %s, Then complete permission details survive recovery and the turn finishes",
    async (decision) => {
        const prompt = "Run the approval verification command, then report its result.";
        const command = `node -e "require('node:fs').writeFileSync('permission-result.txt', 'permission approved')"`;
        await using provider = await FakeOpenAiProvider.start("morty-test-model", "PERMISSION_DETAILS_DONE", {
            toolPrompt: prompt,
            toolSequence: [
                {
                    name: "exec",
                    input: `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)}, sandbox_permissions: "require_escalated", justification: "Verify the permission details round trip" }); text(result.output);`,
                },
            ],
        });
        await using agent = await CodexFixture.create(provider, { approvalPolicy: "on-request" });
        await withRealDaemon(new CodexAgentSpecification(), agent.environment, async (peer) => {
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt,
                    target: peer.target,
                    sessionConfigurations: [{ configId: "mode", type: "select", value: "read-only" }],
                }),
            );
            let approvals = 0;
            const announcedInputs = new Map<string, unknown>();
            let response = "";
            for (;;) {
                const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                    const permission = event.payload.event;
                    approvals += 1;
                    expect(announcedInputs.has(permission.toolCallId)).toBe(true);
                    expect(permission.details?.rawInput).toEqual(announcedInputs.get(permission.toolCallId));
                    expect(permission).toMatchObject({
                        toolKind: "execute",
                        details: {
                            cwd: await realpath(peer.workspace),
                            rawInput: {
                                command: expect.stringContaining(
                                    "writeFileSync('permission-result.txt', 'permission approved')",
                                ),
                            },
                        },
                    });
                    const requestId = randomUUID();
                    peer.send(
                        encodeNativeSessionCommand({
                            action: "active-turn",
                            kind: "native.session.request",
                            requestId,
                            target: peer.target,
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        if (decodeMessageKind(message) !== "native.session.result") {
                            continue;
                        }
                        const snapshot = decodeNativeSessionResult(message);
                        if (snapshot.requestId !== requestId) {
                            continue;
                        }
                        expect(snapshot).toMatchObject({
                            action: "active-turn",
                            interactionState: { interactions: [permission] },
                        });
                        break;
                    }
                    const option = permission.options.find((entry) => entry.kind === decision);
                    if (option === undefined) {
                        throw new Error(`Missing ${decision} permission choice`);
                    }
                    peer.send(
                        encodeSessionPermissionRespondCommand({
                            kind: "session.permission.respond",
                            requestId: crypto.randomUUID(),
                            target: peer.target,
                            interactionId: permission.interactionId,
                            optionId: option.optionId,
                            outcome: "selected",
                        }),
                    );
                } else if (
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "tool_call" ||
                        event.payload.sessionUpdate === "tool_call_update") &&
                    event.payload.rawInput !== undefined
                ) {
                    announcedInputs.set(event.payload.toolCallId, event.payload.rawInput);
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                } else if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    response += event.payload.content.text;
                } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    break;
                }
            }
            expect(approvals).toBe(1);
            expect(response).toContain("PERMISSION_DETAILS_DONE");
            const result = readFile(join(peer.workspace, "permission-result.txt"), "utf8");
            if (decision === "allow_once") {
                expect(await result).toBe("permission approved");
            } else {
                await expect(result).rejects.toMatchObject({ code: "ENOENT" });
            }
        });
    },
);

test.each(["allow_once", "reject_once"] as const)(
    "Given real Claude requests an external file, When the user selects %s, Then its original input and directory survive recovery and the decision reaches the Agent",
    async (decision) => {
        const directory = await mkdtemp(join(tmpdir(), "morty-permission-file-"));
        const file = join(await realpath(directory), "approval-target.txt");
        await writeFile(file, "PERMISSION_FILE_CONTENT");
        try {
            const prompt = "Use a tool to read the external verification file";
            await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "CLAUDE_PERMISSION_DONE", {
                readPath: file,
                toolPrompt: prompt,
            });
            await using agent = await ClaudeFixture.create(provider);
            await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
                const commandId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        commandId,
                        requestId: commandId,
                        disposition: SessionPromptDisposition.Append,
                        attachments: [],
                        kind: "session.prompt",
                        prompt,
                        target: peer.target,
                        sessionConfigurations: [{ configId: "mode", type: "select", value: "default" }],
                    }),
                );
                let approvals = 0;
                let toolResult = "";
                let toolStatus = "";
                let response = "";
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                        const permission = event.payload.event;
                        approvals += 1;
                        expect(permission).toMatchObject({
                            details: {
                                cwd: await realpath(peer.workspace),
                                rawInput: { file_path: file },
                            },
                        });
                        const requestId = randomUUID();
                        peer.send(
                            encodeNativeSessionCommand({
                                action: "active-turn",
                                kind: "native.session.request",
                                requestId,
                                target: peer.target,
                            }),
                        );
                        for (;;) {
                            const message = await peer.nextMessage();
                            if (decodeMessageKind(message) !== "native.session.result") {
                                continue;
                            }
                            const snapshot = decodeNativeSessionResult(message);
                            if (snapshot.requestId !== requestId) {
                                continue;
                            }
                            expect(snapshot).toMatchObject({
                                action: "active-turn",
                                interactionState: { interactions: [permission] },
                            });
                            break;
                        }
                        const option = permission.options.find((entry) => entry.kind === decision);
                        if (option === undefined) {
                            throw new Error(`Missing ${decision} permission choice`);
                        }
                        peer.send(
                            encodeSessionPermissionRespondCommand({
                                kind: "session.permission.respond",
                                requestId: crypto.randomUUID(),
                                target: peer.target,
                                interactionId: permission.interactionId,
                                optionId: option.optionId,
                                outcome: "selected",
                            }),
                        );
                    } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                        throw new Error(JSON.stringify(event));
                    } else if (event.type === "acp" && event.payload.sessionUpdate === "tool_call_update") {
                        toolResult += JSON.stringify(event.payload.content);
                        if (event.payload.status != null) {
                            toolStatus = event.payload.status;
                        }
                    } else if (
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                    ) {
                        response += event.payload.content.text;
                    } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                        break;
                    }
                }
                expect(approvals).toBe(1);
                expect(response).toContain("CLAUDE_PERMISSION_DONE");
                if (decision === "allow_once") {
                    expect(toolResult).toContain("PERMISSION_FILE_CONTENT");
                } else {
                    expect(toolResult).not.toContain("PERMISSION_FILE_CONTENT");
                    expect(toolStatus).toBe("failed");
                }
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
