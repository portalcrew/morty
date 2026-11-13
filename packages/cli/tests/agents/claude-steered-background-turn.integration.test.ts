import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEventEnvelope,
    encodeNativeSessionCommand,
    encodeSessionPromptCommand,
    promptStopReason,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

// Keep the subagent alive across the root result and steering cycle. Only the
// model service is controlled; Claude and the daemon produce all lifecycle events.
test("Given Claude awaits a background subagent, When the user steers and the subagent finishes, Then the turn completes and the next prompt can run", async () => {
    const subagentEntered = Promise.withResolvers<void>();
    const releaseSubagent = Promise.withResolvers<void>();
    const steeringEntered = Promise.withResolvers<void>();
    const releaseSteering = Promise.withResolvers<void>();
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "BACKGROUND_TURN_REPLY", {
        subagent: {
            dispatchDescription: "Check in the background",
            dispatchPrompt: "Delegate the verification to a background helper",
            innerPrompt: "Use a shell tool successfully, then reply with your findings",
            innerReport: "BACKGROUND_HELPER_DONE",
            runInBackground: true,
        },
        beforeFirstText: async (_scenario, signal, conversation) => {
            const gate =
                !conversation.includes("Delegate the verification to a background helper") &&
                conversation.includes("Use a shell tool successfully, then reply with your findings")
                    ? { entered: subagentEntered, release: releaseSubagent }
                    : conversation.includes("Include the updated instruction in your answer")
                      ? { entered: steeringEntered, release: releaseSteering }
                      : null;
            if (gate === null) {
                return;
            }
            gate.entered.resolve();
            const disconnected = Promise.withResolvers<void>();
            const abort = () => disconnected.resolve();
            signal.addEventListener("abort", abort, { once: true });
            try {
                if (!signal.aborted) {
                    await Promise.race([gate.release.promise, disconnected.promise]);
                }
            } finally {
                signal.removeEventListener("abort", abort);
            }
        },
    });
    await using agent = await ClaudeFixture.create(provider);
    try {
        await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
            const stopped = Promise.withResolvers<never>();
            const abort = () => stopped.reject(peer.signal.reason);
            peer.signal.addEventListener("abort", abort, { once: true });
            void stopped.promise.catch(() => undefined);
            const main = randomUUID();
            const steer = randomUUID();
            const completed = new Map<string, string>();
            let results = 0;
            let text = "";
            const sendPrompt = (commandId: string, prompt: string, steering = false) =>
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        commandId,
                        requestId: commandId,
                        target: peer.target,
                        attachments: [],
                        ...(steering
                            ? { disposition: "steer" as const, targetCommandId: main }
                            : { disposition: "append" as const }),
                        prompt,
                    }),
                );
            const next = async (): Promise<string> => {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                if (kind === "session.operation.failed") {
                    throw new Error(message);
                }
                if (kind !== "session.event.v2") {
                    return message;
                }
                for (const event of decodeSessionEventEnvelope(message).events) {
                    if (event.type === "lifecycle-metadata") {
                        if (event.payload.kind === "prompt.failed") {
                            throw new Error(JSON.stringify(event.payload));
                        }
                        if (event.payload.kind === "prompt.completed") {
                            completed.set(event.payload.commandId, promptStopReason(event.payload.completion));
                        }
                        if (event.payload.kind === "session.permission.requested") {
                            const request = event.payload.event;
                            const option = request.options.find((entry) => entry.kind === "allow_once");
                            if (option === undefined) {
                                throw new Error("No tool permission option");
                            }
                            peer.send(
                                JSON.stringify({
                                    kind: "session.permission.respond",
                                    requestId: crypto.randomUUID(),
                                    target: peer.target,
                                    interactionId: request.interactionId,
                                    optionId: option.optionId,
                                    outcome: "selected",
                                }),
                            );
                        }
                    } else if (event.type === "acp") {
                        if (event.payload.sessionUpdate === "usage_update" && event.payload.cost !== undefined) {
                            results += 1;
                        }
                        if (
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            text += event.payload.content.text;
                        }
                    }
                }
                return message;
            };
            const assertTurn = async (commandId: string | null) => {
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
                    if (commandId === null) {
                        expect(result.turn).toBeNull();
                    } else {
                        expect(result.turn).toMatchObject({ commandId });
                    }
                    break;
                }
            };
            sendPrompt(main, "Delegate the verification to a background helper");
            // The result's usage update is the public boundary after Claude's
            // first answer; the held helper prevents the overall prompt completing.
            while (results < 1) {
                await next();
            }
            await Promise.race([subagentEntered.promise, stopped.promise]);
            expect(completed.has(main)).toBe(false);
            sendPrompt(steer, "Include the updated instruction in your answer", true);
            while (completed.get(steer) !== "steered") {
                await next();
            }
            await Promise.race([steeringEntered.promise, stopped.promise]);
            await assertTurn(main);
            releaseSteering.resolve();
            while (results < 2) {
                await next();
            }
            expect(completed.has(main)).toBe(false);
            releaseSubagent.resolve();
            while (!completed.has(main)) {
                await next();
            }
            expect(completed.get(main)).toBe("end_turn");
            expect(text.match(/BACKGROUND_TURN_REPLY/gu)).toHaveLength(3);
            await assertTurn(null);
            const followup = randomUUID();
            sendPrompt(followup, "Continue with the next task");
            while (!completed.has(followup)) {
                await next();
            }
            expect(completed.get(followup)).toBe("end_turn");
            await assertTurn(null);
        });
    } finally {
        releaseSteering.resolve();
        releaseSubagent.resolve();
    }
});
