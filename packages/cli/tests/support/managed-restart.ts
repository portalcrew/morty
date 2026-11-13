import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionHistoryPageLoaded,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    encodeSessionHistoryPageLoad,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@morty-build/client/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

const interruptedPrompt = "Begin work that will be interrupted by the computer restart";

async function journey(peer: RealDaemonPeer, harness: string, reply: string): Promise<void> {
    const sessionTarget = await prepareNewRealSession(peer, harness);
    const prompt = "Remember this conversation across a daemon restart";
    const sendAndFinish = async (text: string): Promise<void> => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId,
                requestId: commandId,
                target: sessionTarget,
                attachments: [],
                prompt: text,
                disposition: SessionPromptDisposition.Append,
            }),
        );
        let output = "";
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                output += event.payload.content.text;
            }
            if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                throw new Error(JSON.stringify(event));
            }
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === commandId
            ) {
                expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
                expect(output).toContain(reply);
                return;
            }
        }
    };
    await sendAndFinish(prompt);
    await peer.restart();
    const requestId = randomUUID();
    peer.send(encodeSessionPrepareCommand({ kind: "session.prepare", requestId, target: sessionTarget }));
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind === "session.ready") {
            const ready = decodeSessionReadyEvent(message);
            if (ready.requestId === requestId) {
                expect(ready.restored).toBe(true);
                break;
            }
        }
    }
    const historyId = randomUUID();
    peer.send(
        encodeSessionHistoryPageLoad({
            kind: "session.live-history.v2.page.load",
            requestId: historyId,
            target: sessionTarget,
            cursor: null,
            eventLimit: 50,
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
        const history = decodeSessionHistoryPageLoaded(message);
        if (history.requestId !== historyId) {
            continue;
        }
        const text = history.events.events.events
            .flatMap((event) =>
                event.type === "acp" &&
                (event.payload.sessionUpdate === "user_message_chunk" ||
                    event.payload.sessionUpdate === "agent_message_chunk") &&
                event.payload.content.type === "text"
                    ? [event.payload.content.text]
                    : [],
            )
            .join("\n");
        expect(text).toContain(prompt);
        expect(text).toContain(reply);
        break;
    }
    await sendAndFinish("Continue the restored conversation");
}

export function registerManagedRestartScenarios(harness: "codex" | "claude" | "pi"): void {
    if (harness === "codex") {
        test("Given a managed real Codex session, When the user quits and starts Morty, Then history is restored and another turn completes", async () => {
            await using provider = await FakeOpenAiProvider.start("gpt-5.4", "MANAGED_CODEX_REPLY");
            await using agent = await CodexFixture.create(provider);
            await withRealDaemon(
                new CodexAgentSpecification(),
                agent.environment,
                (peer) => journey(peer, "codex", "MANAGED_CODEX_REPLY"),
                "managed",
            );
        });
    }
    if (harness === "claude") {
        test("Given a managed real Claude Code session, When the user quits and starts Morty, Then history is restored and another turn completes", async () => {
            await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "MANAGED_CLAUDE_REPLY");
            await using agent = await ClaudeFixture.create(provider);
            await withRealDaemon(
                new ClaudeCodeAgentSpecification(),
                agent.environment,
                (peer) => journey(peer, "claude", "MANAGED_CLAUDE_REPLY"),
                "managed",
            );
        });
    }
    if (harness === "pi") {
        test("Given a managed real Pi session, When the user quits and starts Morty, Then history is restored and another turn completes", async () => {
            await using provider = await FakeOpenAiProvider.start("gpt-4.1", "MANAGED_PI_REPLY");
            await using agent = await PiFixture.create(provider);
            await withRealDaemon(
                new PiAgentSpecification(),
                agent.environment,
                (peer) => journey(peer, "pi", "MANAGED_PI_REPLY"),
                "managed",
            );
        });
    }
}

async function interruptedJourney(
    peer: RealDaemonPeer,
    harness: string,
    entered: Promise<void>,
    release: () => void,
    disconnected: Promise<void>,
): Promise<void> {
    let stage = "preparing the original session";
    try {
        const sessionTarget = await prepareNewRealSession(peer, harness);
        const commandId = randomUUID();
        const sendPrompt = (id: string, prompt: string): void =>
            peer.send(
                encodeSessionPromptCommand({
                    kind: "session.prompt",
                    commandId: id,
                    requestId: id,
                    target: sessionTarget,
                    attachments: [],
                    prompt,
                    disposition: SessionPromptDisposition.Append,
                }),
            );
        sendPrompt(commandId, interruptedPrompt);
        stage = "waiting for the original provider request";
        await awaitPeerOperation(entered, peer.signal);
        stage = "restarting the managed computer";
        await peer.restart("crash");
        stage = "waiting for the old Agent request to disconnect";
        await awaitPeerOperation(disconnected, peer.signal);
        release();
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.failed" &&
                event.payload.commandId === commandId
            ) {
                expect(event.payload.code).toBe("runtime_restarted");
                break;
            }
        }
        stage = "restoring the native session";
        const requestId = randomUUID();
        peer.send(encodeSessionPrepareCommand({ kind: "session.prepare", requestId, target: sessionTarget }));
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.operation.failed") {
                throw new Error(message);
            }
            if (kind === "session.ready" && decodeSessionReadyEvent(message).requestId === requestId) {
                expect(decodeSessionReadyEvent(message).restored).toBe(true);
                break;
            }
        }
        stage = "reading restored conversation history";
        const historyId = randomUUID();
        peer.send(
            encodeSessionHistoryPageLoad({
                kind: "session.live-history.v2.page.load",
                requestId: historyId,
                target: sessionTarget,
                cursor: null,
                eventLimit: 100,
            }),
        );
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) === "session.operation.failed") {
                throw new Error(message);
            }
            if (decodeMessageKind(message) !== "session.live-history.v2.page.loaded") {
                continue;
            }
            const history = decodeSessionHistoryPageLoaded(message);
            if (history.requestId !== historyId) {
                continue;
            }
            expect(
                history.events.events.events.some(
                    (event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "user_message_chunk" &&
                        event.payload.content.type === "text" &&
                        event.payload.content.text === interruptedPrompt,
                ),
            ).toBe(true);
            expect(history.events.events.events.every((event) => event.type === "acp")).toBe(true);
            break;
        }
        stage = "completing the continuation";
        const continuation = randomUUID();
        sendPrompt(
            continuation,
            "The computer restarted. Review the native conversation and continue unfinished work. Check before repeating side effects.",
        );
        for (;;) {
            const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
            ) {
                throw new Error(JSON.stringify(event.payload));
            }
            if (
                event.type === "lifecycle-metadata" &&
                event.payload.kind === "prompt.completed" &&
                event.payload.commandId === continuation
            ) {
                expect(event.payload.completion).toEqual({ kind: "ended", stopReason: "end_turn" });
                return;
            }
        }
    } catch (cause) {
        throw new Error(`Could not continue ${harness} while ${stage}`, { cause });
    }
}

async function awaitPeerOperation(operation: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const abort = (): void => aborted.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
        await Promise.race([operation, aborted.promise]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

function firstRequestGate() {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    let first = true;
    return {
        entered: entered.promise,
        disconnected: disconnected.promise,
        release: () => release.resolve(),
        beforeFirstText: async (signal: AbortSignal) => {
            if (!first) {
                return;
            }
            first = false;
            signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
            if (signal.aborted) {
                disconnected.resolve();
            }
            entered.resolve();
            await release.promise;
        },
    };
}

export function registerManagedCrashScenarios(harness: "codex" | "claude" | "pi"): void {
    if (harness === "codex") {
        // @no-uc: Compatibility; a real Codex native session remains resumable after an interrupted request.
        test("Given a running real Codex request, When SIGKILL restarts its managed computer, Then a continuation completes in the native session", async () => {
            const gate = firstRequestGate();
            await using provider = await FakeOpenAiProvider.start("gpt-5.4", "RESTART_CONTINUED", {
                beforeFirstText: gate.beforeFirstText,
            });
            await using agent = await CodexFixture.create(provider);
            try {
                await withRealDaemon(
                    new CodexAgentSpecification(),
                    agent.environment,
                    (peer) => interruptedJourney(peer, "codex", gate.entered, gate.release, gate.disconnected),
                    "managed",
                );
            } finally {
                gate.release();
            }
        }, 120_000);
    }
    if (harness === "claude") {
        // @no-uc: Compatibility; a real Claude native session remains resumable after an interrupted request.
        test("Given a running real Claude request, When SIGKILL restarts its managed computer, Then a continuation completes in the native session", async () => {
            const gate = firstRequestGate();
            await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-5", "RESTART_CONTINUED", {
                beforeFirstText: async (_scenario, signal, conversation) => {
                    // Claude also sends startup probes to the model provider. Only the
                    // user's running turn establishes the crash scenario's boundary.
                    if (conversation.includes(interruptedPrompt)) {
                        await gate.beforeFirstText(signal);
                    }
                },
            });
            await using agent = await ClaudeFixture.create(provider);
            try {
                await withRealDaemon(
                    new ClaudeCodeAgentSpecification(),
                    agent.environment,
                    (peer) => interruptedJourney(peer, "claude", gate.entered, gate.release, gate.disconnected),
                    "managed",
                );
            } finally {
                gate.release();
            }
        }, 120_000);
    }
    if (harness === "pi") {
        // @no-uc: Compatibility; a real Pi native session remains resumable after an interrupted request.
        test("Given a running real Pi request, When SIGKILL restarts its managed computer, Then a continuation completes in the native session", async () => {
            const gate = firstRequestGate();
            await using provider = await FakeOpenAiProvider.start("gpt-5.4", "RESTART_CONTINUED", {
                beforeFirstText: gate.beforeFirstText,
            });
            await using agent = await PiFixture.create(provider);
            try {
                await withRealDaemon(
                    new PiAgentSpecification(),
                    agent.environment,
                    (peer) => interruptedJourney(peer, "pi", gate.entered, gate.release, gate.disconnected),
                    "managed",
                );
            } finally {
                gate.release();
            }
        }, 120_000);
    }
}
