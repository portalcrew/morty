import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    encodeNativeSessionCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    type SessionEventPayload,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import { threadStartResponseSchema } from "../../src/engine/acp/harness/codex/app-server-protocol.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { stopProcessTree } from "../../src/engine/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.each(["owned", "borrowed"])(
    "Given a real %s Codex conversation in Plan mode, When it completes a proposed plan and is reopened, Then its full body appears once with the same native identity",
    async (ownership) => {
        const body =
            "# PLAN_BODY\n\n1. Preserve the default addition behavior.\n2. Add division and verify zero-divisor handling.";
        await using provider = await FakeOpenAiProvider.start(
            "morty-test-model",
            `<proposed_plan>\n${body}\n</proposed_plan>\n`,
        );
        await using codex = await CodexFixture.create(provider, { configuredModel: "morty-test-model" });
        await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
            const seeded = Promise.withResolvers<void>();
            const native =
                ownership === "borrowed"
                    ? new CodexAppServerClient({
                          command: codex.executable,
                          cwd: peer.workspace,
                          environment: codex.environment,
                          handlers: {
                              onNotification: async (method) => {
                                  if (method === "turn/completed") {
                                      seeded.resolve();
                                  }
                              },
                              onServerRequest: async () => {
                                  throw new Error("The plan must not request native input");
                              },
                          },
                      })
                    : null;
            try {
                let sessionTarget = peer.target;
                if (native !== null) {
                    await native.initialize(peer.signal);
                    const { thread } = threadStartResponseSchema.parse(
                        await native.request(
                            "thread/start",
                            {
                                cwd: peer.workspace,
                                model: "morty-test-model",
                            },
                            peer.signal,
                        ),
                    );
                    await native.request(
                        "thread/settings/update",
                        {
                            threadId: thread.id,
                            collaborationMode: {
                                mode: "plan",
                                settings: {
                                    model: "morty-test-model",
                                    reasoning_effort: "low",
                                    developer_instructions: null,
                                },
                            },
                        },
                        peer.signal,
                    );
                    await native.request(
                        "turn/start",
                        {
                            threadId: thread.id,
                            input: [{ type: "text", text: "Seed this native conversation", text_elements: [] }],
                        },
                        peer.signal,
                    );
                    {
                        using _abort = addAbortListener(peer.signal, () => seeded.reject(peer.signal.reason));
                        await seeded.promise;
                    }
                    const identity = {
                        harness: "codex",
                        directory: ".",
                        kind: "native.session.request",
                    } as const;
                    const findId = randomUUID();
                    peer.send(
                        encodeNativeSessionCommand({
                            ...identity,
                            requestId: findId,
                            action: "find",
                            sessionId: thread.id,
                        }),
                    );
                    const found = await nativeResult(peer, findId);
                    if (found.action !== "find") {
                        throw new Error("The native conversation was not found");
                    }
                    const importId = randomUUID();
                    peer.send(
                        encodeNativeSessionCommand({
                            ...identity,
                            requestId: importId,
                            action: "import",
                            sessionId: found.entry.sessionId,
                        }),
                    );
                    const imported = await nativeResult(peer, importId);
                    if (imported.action !== "import") {
                        throw new Error("Expected native import");
                    }
                    sessionTarget = imported.target;
                }
                const commandId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        commandId,
                        requestId: commandId,
                        target: sessionTarget,
                        attachments: [],
                        prompt: "Stream a concise proposed plan",
                        disposition: SessionPromptDisposition.Append,
                        sessionConfigurations: [{ configId: "collaboration_mode", type: "select", value: "plan" }],
                    }),
                );
                const live: SessionEventPayload[] = [];
                for (;;) {
                    const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                    live.push(event);
                    if (event.type !== "lifecycle-metadata") {
                        continue;
                    }
                    if (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start") {
                        throw new Error(JSON.stringify(event));
                    }
                    if (event.payload.kind === "prompt.completed" && event.payload.commandId === commandId) {
                        expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
                        break;
                    }
                }
                const livePlan = planMessages(live);
                expect.soft(livePlan.map((message) => message.text.trim())).toEqual([body]);
                await peer.restart();
                peer.send(
                    encodeSessionHistoryPageLoad({
                        kind: "session.live-history.v2.page.load",
                        requestId: randomUUID(),
                        target: sessionTarget,
                        cursor: null,
                        eventLimit: 100,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    const kind = decodeMessageKind(message);
                    if (kind === "session.operation.failed") {
                        throw new Error(message);
                    }
                    if (kind !== "session.live-history.v2.page.loaded") {
                        continue;
                    }
                    const savedPlan = planMessages(decodeSessionHistoryPageLoaded(message).events.events.events);
                    expect(savedPlan.map((message) => message.text.trim())).toEqual(
                        ownership === "borrowed" ? [body, body] : [body],
                    );
                    expect(savedPlan.at(-1)?.messageId).toEqual(expect.any(String));
                    expect(savedPlan.at(-1)?.messageId).toBe(livePlan[0]?.messageId);
                    break;
                }
            } finally {
                if (native !== null) {
                    native.detach();
                    await stopProcessTree(native.child());
                }
            }
        });
    },
);

async function nativeResult(peer: RealDaemonPeer, requestId: string) {
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind === "native.session.result") {
            const result = decodeNativeSessionResult(message);
            if (result.requestId === requestId) {
                return result;
            }
        }
    }
}

function planMessages(events: readonly SessionEventPayload[]) {
    return events.flatMap((event) =>
        event.type === "acp" &&
        event.payload.sessionUpdate === "agent_message_chunk" &&
        event.payload.content.type === "text" &&
        event.payload.content.text.includes("PLAN_BODY")
            ? [{ messageId: event.payload.messageId, text: event.payload.content.text }]
            : [],
    );
}
