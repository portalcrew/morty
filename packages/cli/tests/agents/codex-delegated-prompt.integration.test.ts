import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    encodeNativeSessionCommand,
    encodeSessionCancelCommand,
    encodeSessionPromptCommand,
    promptStopReason,
    type SessionLiveEvent,
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

test("Given the Codex app owns a thread whose last turn it interrupted, When a message sent here waits in its paused queue and is stopped, Then it is withdrawn, the owner's later turns still arrive, and a later message reports when the owner starts it", async () => {
    const entered = Promise.withResolvers<void>();
    let holding = true;
    await using provider = await FakeOpenAiProvider.start("morty-test-model", "OWNER_REPLY", {
        beforeFirstText: async (signal) => {
            if (holding) {
                holding = false;
                entered.resolve();
                // Held until the owner interrupts the turn.
                await new Promise<void>((resolve) => {
                    signal.addEventListener("abort", () => resolve(), { once: true });
                });
            }
        },
    });
    await using codex = await CodexFixture.create(provider, { configuredModel: "morty-test-model" });
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        let completed = Promise.withResolvers<{ readonly turn: { readonly status: string } }>();
        using _abort = addAbortListener(peer.signal, () => {
            entered.reject(peer.signal.reason);
            completed.reject(peer.signal.reason);
        });
        const owner = new CodexAppServerClient({
            command: codex.executable,
            cwd: peer.workspace,
            environment: codex.environment,
            handlers: {
                onNotification: async (method, params) => {
                    if (method === "turn/completed") {
                        completed.resolve(z.object({ turn: z.object({ status: z.string() }) }).parse(params));
                    }
                },
                onServerRequest: async () => {
                    throw new Error("The owner must not be asked for input");
                },
            },
        });
        try {
            await owner.initialize(peer.signal);
            const { thread } = threadStartResponseSchema.parse(
                await owner.request("thread/start", { cwd: peer.workspace, model: "morty-test-model" }, peer.signal),
            );
            const ownerTurn = async (text: string): Promise<string> =>
                z
                    .object({ turn: z.object({ id: z.string() }) })
                    .parse(
                        await owner.request(
                            "turn/start",
                            { threadId: thread.id, input: [{ type: "text", text, text_elements: [] }] },
                            peer.signal,
                        ),
                    ).turn.id;
            const interrupted = await ownerTurn("The owner's turn that its user stops");
            await entered.promise;
            await owner.request("turn/interrupt", { threadId: thread.id, turnId: interrupted }, peer.signal);
            expect((await completed.promise).turn.status).toBe("interrupted");
            const sessionTarget = await importThread(peer, thread.id);

            const withdrawn = sendPrompt(peer, sessionTarget, "Waits in the paused queue");
            await nextEvent(peer, (event) => delegation(event, withdrawn) === "queued");
            const queue = z.object({ data: z.array(z.unknown()) });
            expect(
                queue.parse(await owner.request("thread/queue/list", { threadId: thread.id }, peer.signal)).data,
            ).toHaveLength(1);
            peer.send(
                encodeSessionCancelCommand({
                    kind: "session.cancel",
                    requestId: crypto.randomUUID(),
                    commandId: withdrawn,
                    target: sessionTarget,
                }),
            );
            await nextEvent(
                peer,
                (event) =>
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.completed" &&
                    event.payload.commandId === withdrawn &&
                    promptStopReason(event.payload.completion) === "cancelled",
            );
            expect(
                queue.parse(await owner.request("thread/queue/list", { threadId: thread.id }, peer.signal)).data,
            ).toEqual([]);

            // Stopping a queued message leaves this Computer following the owner's thread.
            completed = Promise.withResolvers();
            await ownerTurn("Typed in the Codex app");
            await nextEvent(peer, (event) => userText(event) === "Typed in the Codex app");
            await nextEvent(peer, (event) => agentText(event)?.includes("OWNER_REPLY") === true);
            expect((await completed.promise).turn.status).toBe("completed");

            // The owner is idle after a completed turn, so it starts queued input at once.
            const delegated = sendPrompt(peer, sessionTarget, "Started by the owner");
            await nextEvent(peer, (event) => delegation(event, delegated) === "queued");
            await nextEvent(peer, (event) => delegation(event, delegated) === "started");
            await nextEvent(peer, (event) => userText(event) === "Started by the owner");
            await nextEvent(
                peer,
                (event) =>
                    event.type === "lifecycle-metadata" &&
                    event.payload.kind === "prompt.completed" &&
                    event.payload.commandId === delegated &&
                    promptStopReason(event.payload.completion) === "end_turn",
            );
        } finally {
            owner.detach();
            await stopProcessTree(owner.child());
        }
    });
});

function sendPrompt(peer: RealDaemonPeer, sessionTarget: RealDaemonPeer["target"], prompt: string): string {
    const commandId = randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            attachments: [],
            commandId,
            requestId: commandId,
            disposition: SessionPromptDisposition.Append,
            kind: "session.prompt",
            prompt,
            target: sessionTarget,
        }),
    );
    return commandId;
}

function delegation(event: SessionLiveEvent, commandId: string): string | null {
    return event.type === "lifecycle-metadata" &&
        event.payload.kind === "prompt.delegated" &&
        event.payload.commandId === commandId
        ? event.payload.stage
        : null;
}

function userText(event: SessionLiveEvent): string | null {
    return event.type === "acp" &&
        event.payload.sessionUpdate === "user_message_chunk" &&
        event.payload.content.type === "text"
        ? event.payload.content.text
        : null;
}

function agentText(event: SessionLiveEvent): string | null {
    return event.type === "acp" &&
        event.payload.sessionUpdate === "agent_message_chunk" &&
        event.payload.content.type === "text"
        ? event.payload.content.text
        : null;
}

async function nextEvent(peer: RealDaemonPeer, matches: (event: SessionLiveEvent) => boolean): Promise<void> {
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (
            event.type === "lifecycle-metadata" &&
            (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
        ) {
            throw new Error(JSON.stringify(event));
        }
        if (matches(event)) {
            return;
        }
    }
}

async function importThread(peer: RealDaemonPeer, threadId: string): Promise<RealDaemonPeer["target"]> {
    const identity = {
        harness: "codex",
        directory: ".",
        kind: "native.session.request",
    } as const;
    const findId = randomUUID();
    peer.send(encodeNativeSessionCommand({ ...identity, requestId: findId, action: "find", sessionId: threadId }));
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
    expect(imported).toMatchObject({
        action: "import",
        ready: { capabilities: { steering: false } },
    });
    if (imported.action !== "import") {
        throw new Error("Expected native import");
    }
    return imported.target;
}

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
