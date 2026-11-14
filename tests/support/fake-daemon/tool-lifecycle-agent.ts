import * as acp from "@agentclientprotocol/sdk/unstable";
import {
    type ControlledAcpPeer,
    ControlledEndpointConnection,
    type ControlledSessionUpdate,
    controlledSessionUpdates,
    fakeHarnessCapabilities,
} from "@morty-build/runtime-test-support/fake-daemon";
import type { AgentTermination } from "../../../packages/cli/src/engine/acp/agent/agent-lifecycle.ts";
import { createControlledAgent } from "../../../packages/cli/tests/support/agents/controlled-agent-definition.ts";

/** Stateful ACP peer that deliberately leaves tool status updates unfinished at turn termination. */
export function createToolLifecycleAgent(beforeCancellationApplied?: () => Promise<void>) {
    const sessions = new Map<string, acp.SessionNotification[]>();
    const steeringToolCounts = new Map<string, number>();
    const heldSteering = new Set<string>();
    const delayedUserMessages = new Map<string, acp.SessionUpdate[]>();
    const createEndpoint = (onSessionUpdate: ControlledSessionUpdate): ControlledAcpPeer => {
        const termination = Promise.withResolvers<AgentTermination>();
        const lifetime = new AbortController();
        const turns = new Map<string, AbortController>();
        const app = acp
            .agent({ name: "tool-lifecycle-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                _meta: { steering: { supported: true } },
                agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {}, resume: {} } },
                agentInfo: { name: "Tool Lifecycle Agent", version: "controlled-harness" },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                sessions.set(sessionId, []);
                return { sessionId, configOptions: [] };
            })
            .onRequest(acp.methods.agent.session.load, async (context) => {
                for (const event of sessions.get(context.params.sessionId) ?? []) {
                    await onSessionUpdate(event);
                }
                return { configOptions: [] };
            })
            .onRequest(acp.methods.agent.session.resume, () => ({ configOptions: [] }))
            .onRequest(acp.methods.agent.session.list, () => ({ sessions: [] }))
            .onRequest(acp.methods.agent.session.prompt, async (context) => {
                const sessionId = context.params.sessionId;
                const history = sessions.get(sessionId);
                if (history === undefined) {
                    throw new Error("Unknown controlled session");
                }
                const prompt = context.params.prompt
                    .flatMap((content) => (content.type === "text" ? [content.text] : []))
                    .join("\n");
                steeringToolCounts.set(sessionId, prompt === "hold paginated steering" ? 32 : 1);
                if (prompt === "hold steering acknowledgement") {
                    heldSteering.add(sessionId);
                } else {
                    heldSteering.delete(sessionId);
                }
                const cancellation = new AbortController();
                turns.set(sessionId, cancellation);
                const signal = AbortSignal.any([context.signal, lifetime.signal, cancellation.signal]);
                const emit = async (update: acp.SessionNotification["update"]) => {
                    const event: acp.SessionNotification = { sessionId, update };
                    history.push(event);
                    await onSessionUpdate(event);
                };
                const messageId = crypto.randomUUID();
                const userUpdates: acp.SessionUpdate[] = context.params.prompt.map((content) => ({
                    sessionUpdate: "user_message_chunk",
                    messageId,
                    content,
                }));
                if (prompt === "hold delayed initial message" || prompt === "hold before first acp") {
                    delayedUserMessages.set(sessionId, userUpdates);
                } else {
                    for (const update of userUpdates) {
                        await emit(update);
                    }
                }
                const emitText = async (text: string) =>
                    await emit({
                        sessionUpdate: "agent_message_chunk",
                        messageId: crypto.randomUUID(),
                        content: { type: "text", text },
                    });
                const emitTool = async (title: string, status: acp.ToolCallStatus, content: acp.ToolCallContent[]) =>
                    await emit({
                        sessionUpdate: "tool_call",
                        toolCallId: crypto.randomUUID(),
                        title,
                        status,
                        kind: "other",
                        rawInput: { task: title },
                        content,
                    });
                try {
                    if (prompt === "start background verification") {
                        await emit({
                            sessionUpdate: "tool_call",
                            toolCallId: `background-${sessionId}`,
                            title: "Background verification",
                            kind: "other",
                            status: "completed",
                            _meta: { "morty.backgroundTask": { id: "verification", status: "running" } },
                            content: [],
                        });
                        await emitText("Background verification launched.");
                        return { stopReason: "end_turn", _meta: { messageId } };
                    }
                    const backgroundStatus = prompt.replace("finish background verification ", "");
                    if (
                        backgroundStatus === "completed" ||
                        backgroundStatus === "failed" ||
                        backgroundStatus === "stopped" ||
                        backgroundStatus === "unknown"
                    ) {
                        await emit({
                            sessionUpdate: "tool_call_update",
                            toolCallId: `background-${sessionId}`,
                            status: backgroundStatus === "completed" ? "completed" : "failed",
                            _meta: { "morty.backgroundTask": { id: "verification", status: backgroundStatus } },
                            content: [
                                {
                                    type: "content",
                                    content: { type: "text", text: `Background verification ${backgroundStatus}` },
                                },
                            ],
                        });
                        return { stopReason: "end_turn", _meta: { messageId } };
                    }
                    if (prompt === "update one tool in place") {
                        const toolCallId = crypto.randomUUID();
                        await emit({
                            sessionUpdate: "tool_call",
                            toolCallId,
                            title: "Updated verification",
                            status: "in_progress",
                            kind: "other",
                            rawInput: { task: "Updated verification" },
                        });
                        await emit({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
                        await emitText("The updated tool finished.");
                        return { stopReason: "end_turn", _meta: { messageId } };
                    }
                    if (prompt === "answer after verification" || prompt === "answer then hold") {
                        await emitTool("Completed verification", "completed", []);
                        if (prompt === "answer then hold") {
                            await emitText("Partial answer before stopping.");
                            const stopped = Promise.withResolvers<acp.PromptResponse>();
                            const abort = () => stopped.resolve({ stopReason: "cancelled" });
                            signal.addEventListener("abort", abort, { once: true });
                            try {
                                if (signal.aborted) {
                                    abort();
                                }
                                return await stopped.promise;
                            } finally {
                                signal.removeEventListener("abort", abort);
                            }
                        }
                        await emitTool("Update notes", "completed", [
                            { type: "diff", path: "/workspace/notes.md", oldText: "before\n", newText: "after\n" },
                        ]);
                        await emitText("Checking the failed verification.");
                        await emitTool("Failed verification", "failed", []);
                        await emitText("Verification finished with one failure.");
                        return { stopReason: "end_turn", _meta: { messageId } };
                    }
                    for (const [title, status] of [
                        ["Completed verification", "completed"],
                        ["Failed verification", "failed"],
                        ["Unfinished verification", "in_progress"],
                        ["Pending verification", "pending"],
                    ] satisfies readonly (readonly [string, acp.ToolCallStatus])[]) {
                        if (prompt === "hold before first acp") {
                            break;
                        }
                        const event: acp.SessionNotification = {
                            sessionId,
                            update: {
                                sessionUpdate: "tool_call",
                                toolCallId: crypto.randomUUID(),
                                title,
                                status,
                                kind: "other",
                                rawInput: { task: title },
                            },
                        };
                        history.push(event);
                        await onSessionUpdate(event);
                    }
                    if (prompt === "fail unfinished tools") {
                        throw new Error("Controlled Agent execution failed");
                    }
                    for (const stopReason of ["max_tokens", "max_turn_requests", "refusal"] as const) {
                        if (prompt === `stop with ${stopReason}`) {
                            return { stopReason, _meta: { messageId } };
                        }
                    }
                    if (prompt === "complete unfinished tools") {
                        return { stopReason: "end_turn", _meta: { messageId } };
                    }
                    const finished = Promise.withResolvers<acp.PromptResponse>();
                    const abort = () => finished.resolve({ stopReason: "cancelled" });
                    signal.addEventListener("abort", abort, { once: true });
                    try {
                        if (signal.aborted) {
                            abort();
                        }
                        return await finished.promise;
                    } finally {
                        signal.removeEventListener("abort", abort);
                    }
                } finally {
                    turns.delete(sessionId);
                    delayedUserMessages.delete(sessionId);
                }
            })
            .onRequest(
                "_session/steering",
                (params: unknown) => params,
                async (context) => {
                    const params = context.params;
                    if (
                        params === null ||
                        typeof params !== "object" ||
                        !("sessionId" in params) ||
                        typeof params.sessionId !== "string"
                    ) {
                        throw new Error("Invalid controlled steering request");
                    }
                    const history = sessions.get(params.sessionId);
                    if (history === undefined || !turns.has(params.sessionId)) {
                        return { outcome: "promptRequired" };
                    }
                    const count = steeringToolCounts.get(params.sessionId) ?? 1;
                    for (const update of delayedUserMessages.get(params.sessionId) ?? []) {
                        const event: acp.SessionNotification = { sessionId: params.sessionId, update };
                        history.push(event);
                        await onSessionUpdate(event);
                    }
                    delayedUserMessages.delete(params.sessionId);
                    const messageId = crypto.randomUUID();
                    const prompt: unknown = Reflect.get(params, "prompt");
                    if (!Array.isArray(prompt)) {
                        throw new Error("Invalid steering content");
                    }
                    for (const block of prompt) {
                        if (typeof block !== "object" || block === null || Reflect.get(block, "type") !== "text") {
                            throw new Error("Invalid steering content");
                        }
                        const text: unknown = Reflect.get(block, "text");
                        if (typeof text !== "string") {
                            throw new Error("Invalid steering text");
                        }
                        const content: acp.ContentBlock = { type: "text", text };
                        const event: acp.SessionNotification = {
                            sessionId: params.sessionId,
                            update: { sessionUpdate: "user_message_chunk", messageId, content },
                        };
                        history.push(event);
                        await onSessionUpdate(event);
                    }
                    for (let index = 0; index < count; index += 1) {
                        const event: acp.SessionNotification = {
                            sessionId: params.sessionId,
                            update: {
                                sessionUpdate: "tool_call",
                                toolCallId: crypto.randomUUID(),
                                title: count === 1 ? "Steered verification" : `Steered verification ${index + 1}`,
                                status: "in_progress",
                                kind: "other",
                            },
                        };
                        history.push(event);
                        await onSessionUpdate(event);
                    }
                    const turn = turns.get(params.sessionId);
                    if (heldSteering.has(params.sessionId) && turn !== undefined) {
                        const signal = AbortSignal.any([context.signal, lifetime.signal, turn.signal]);
                        const finished = Promise.withResolvers<void>();
                        const abort = () => finished.resolve();
                        signal.addEventListener("abort", abort, { once: true });
                        try {
                            if (signal.aborted) {
                                abort();
                            }
                            await finished.promise;
                        } finally {
                            signal.removeEventListener("abort", abort);
                        }
                    }
                    return { outcome: "injected" };
                },
            )
            .onNotification(acp.methods.agent.session.cancel, async (context) => {
                const turn = turns.get(context.params.sessionId);
                await beforeCancellationApplied?.();
                turn?.abort();
            })
            .onRequest(acp.methods.agent.session.close, (context) => {
                turns.get(context.params.sessionId)?.abort();
                return {};
            });
        return {
            app: () => app,
            terminated: termination.promise,
            initialize: async (signal) => signal.throwIfAborted(),
            close: async () => {
                lifetime.abort();
                termination.resolve({ kind: "closed" });
            },
        };
    };
    return createControlledAgent(
        (options) =>
            new ControlledEndpointConnection(createEndpoint(controlledSessionUpdates(options.client)), options.client),
        "tool-lifecycle-test",
        "Tool Lifecycle Agent",
        process.execPath,
        {},
        "controlled-harness",
        fakeHarnessCapabilities,
    );
}
