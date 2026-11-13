import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    encodeNativeSessionCommand,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { z } from "zod";
import { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import { threadStartResponseSchema } from "../../src/engine/acp/harness/codex/app-server-protocol.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { stopProcessTree } from "../../src/engine/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a borrowed Codex conversation with queued input, When the user stops it, Then the input is withdrawn and the native owner can finish", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "OWNER_FINISHED", {
        beforeFirstText: async (signal) => {
            entered.resolve();
            using _abort = addAbortListener(signal, () => release.resolve());
            await release.promise;
        },
    });
    await using codex = await CodexFixture.create(provider, { configuredModel: "morty-test-model" });
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const queued = Promise.withResolvers<void>();
        const completed = Promise.withResolvers<unknown>();
        using _abort = addAbortListener(peer.signal, () => {
            entered.reject(peer.signal.reason);
            queued.reject(peer.signal.reason);
            completed.reject(peer.signal.reason);
        });
        const native = new CodexAppServerClient({
            command: codex.executable,
            cwd: peer.workspace,
            environment: codex.environment,
            handlers: {
                onNotification: async (method, params) => {
                    if (method === "thread/queue/changed") {
                        queued.resolve();
                    }
                    if (method === "turn/completed") {
                        completed.resolve(params);
                    }
                },
                onServerRequest: async () => {
                    throw new Error("The native owner must not request input");
                },
            },
        });
        try {
            await native.initialize(peer.signal);
            const { thread } = threadStartResponseSchema.parse(
                await native.request("thread/start", { cwd: peer.workspace, model: "morty-test-model" }, peer.signal),
            );
            await native.request(
                "turn/start",
                {
                    threadId: thread.id,
                    input: [{ type: "text", text: "Finish the native owner's turn", text_elements: [] }],
                },
                peer.signal,
            );
            await entered.promise;
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
            if (found.action !== "find" || found.entry === null) {
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
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    commandId,
                    requestId: commandId,
                    disposition: SessionPromptDisposition.Append,
                    attachments: [],
                    kind: "session.prompt",
                    prompt: "This queued instruction must be withdrawn",
                    target: imported.target,
                }),
            );
            await queued.promise;
            const queue = z.object({ data: z.array(z.object({ id: z.string() })) });
            expect(
                queue.parse(await native.request("thread/queue/list", { threadId: thread.id }, peer.signal)).data,
            ).toHaveLength(1);
            peer.send(
                encodeSessionCancelCommand({
                    kind: "session.cancel",
                    requestId: crypto.randomUUID(),
                    commandId,
                    target: imported.target,
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
                    expect(event.payload.completion).toMatchObject({ kind: "cancelled" });
                    break;
                }
            }
            expect(
                queue.parse(await native.request("thread/queue/list", { threadId: thread.id }, peer.signal)).data,
            ).toEqual([]);
            release.resolve();
            expect(await completed.promise).toMatchObject({ turn: { status: "completed" } });
        } finally {
            release.resolve();
            native.detach();
            await stopProcessTree(native.child());
        }
    });
});

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
