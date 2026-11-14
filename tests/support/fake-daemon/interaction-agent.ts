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

/** A stateful ACP peer injected through the production daemon's Agent port. */
export function createInteractionAgent(onBackgroundPermissionReady?: (request: () => Promise<void>) => void) {
    const sessions = new Set<string>();
    const createEndpoint = (onSessionUpdate: ControlledSessionUpdate): ControlledAcpPeer => {
        const termination = Promise.withResolvers<AgentTermination>();
        const lifetime = new AbortController();
        const turns = new Map<string, AbortController>();
        const app = acp
            .agent({ name: "morty-interaction-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {}, resume: {} } },
                agentInfo: { name: "Interaction Agent", version: "controlled-harness" },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                sessions.add(sessionId);
                return { sessionId, configOptions: [] };
            })
            .onRequest(acp.methods.agent.session.load, () => ({ configOptions: [] }))
            .onRequest(acp.methods.agent.session.resume, () => ({ configOptions: [] }))
            .onRequest(acp.methods.agent.session.list, () => ({ sessions: [] }))
            .onRequest(acp.methods.agent.session.prompt, async (context) => {
                const sessionId = context.params.sessionId;
                if (!sessions.has(sessionId)) {
                    throw new Error("Unknown controlled session");
                }
                if (
                    context.params.prompt.some(
                        (content) => content.type === "text" && content.text === "request background permission",
                    )
                ) {
                    onBackgroundPermissionReady?.(async () => {
                        const result = await context.client.request(
                            acp.methods.client.session.requestPermission,
                            {
                                sessionId,
                                options: [{ optionId: "allow-once", kind: "allow_once", name: "Verify" }],
                                toolCall: {
                                    toolCallId: crypto.randomUUID(),
                                    kind: "execute",
                                    title: "Background verification",
                                    status: "pending",
                                    rawInput: { command: "echo verified" },
                                },
                            },
                            { cancellationSignal: lifetime.signal },
                        );
                        await onSessionUpdate({
                            sessionId,
                            update: {
                                sessionUpdate: "agent_message_chunk",
                                messageId: crypto.randomUUID(),
                                content: {
                                    type: "text",
                                    text: `Background decision: ${result.outcome.outcome === "selected" ? result.outcome.optionId : "cancelled"}`,
                                },
                            },
                        });
                    });
                    await onSessionUpdate({
                        sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            messageId: crypto.randomUUID(),
                            content: { type: "text", text: "Foreground work completed" },
                        },
                    });
                    return { stopReason: "end_turn" };
                }
                const cancellation = new AbortController();
                turns.set(sessionId, cancellation);
                const signal = AbortSignal.any([lifetime.signal, context.signal, cancellation.signal]);
                const longPermission = context.params.prompt.some(
                    (content) => content.type === "text" && content.text === "request long permission",
                );
                const longPath = `/workspace/${"long-directory-".repeat(12)}/src/index.ts`;
                const planMode = context.params.prompt.some(
                    (content) => content.type === "text" && content.text === "request plan mode",
                );
                const sessionScope = context.params.prompt.some(
                    (content) => content.type === "text" && content.text === "request session permission",
                );
                const fileEdit = context.params.prompt.some(
                    (content) => content.type === "text" && content.text === "request file edit",
                );
                const options: acp.PermissionOption[] = sessionScope
                    ? [
                          { optionId: "allow-session", kind: "allow_always", name: "Allow for this session" },
                          { optionId: "deny-session", kind: "reject_always", name: "Deny for this session" },
                      ]
                    : planMode
                      ? [
                            { optionId: "allow-once", kind: "allow_once", name: "Yes, enter plan mode" },
                            { optionId: "reject", kind: "reject_once", name: "No, start implementing now" },
                        ]
                      : [
                            {
                                optionId: "allow-once",
                                kind: "allow_once",
                                name: longPermission ? `Allow reading ${longPath} for this session` : "Yes",
                            },
                            { optionId: "reject", kind: "reject_once", name: "No" },
                        ];
                try {
                    if (
                        context.params.prompt.some(
                            (content) => content.type === "text" && content.text === "request text answers",
                        )
                    ) {
                        const input = await context.client.request(
                            acp.methods.client.elicitation.create,
                            {
                                sessionId,
                                mode: "form",
                                message: "Edit the text answers; empty answers are valid",
                                requestedSchema: {
                                    type: "object",
                                    properties: {
                                        name: {
                                            type: "string",
                                            title: "Name",
                                            default: "Initial name",
                                            maxLength: 10_000,
                                        },
                                        draft: {
                                            type: "string",
                                            title: "Draft",
                                            default: `${String.fromCodePoint(0x7b2c, 0x4e00, 0x884c)}\nSecond line`,
                                            maxLength: 10_000,
                                            _meta: { "io.morty/multiline": true },
                                        },
                                        nickname: { type: "string", title: "Optional nickname", minLength: 1 },
                                        code: { type: "string", title: "Optional code", pattern: "^[A-Z]+$" },
                                    },
                                    required: ["name", "draft"],
                                },
                            },
                            { cancellationSignal: signal },
                        );
                        await onSessionUpdate({
                            sessionId,
                            update: {
                                sessionUpdate: "agent_message_chunk",
                                messageId: crypto.randomUUID(),
                                content: { type: "text", text: `Text answers: ${JSON.stringify(input)}` },
                            },
                        });
                        return { stopReason: "end_turn" };
                    }
                    if (fileEdit) {
                        // Like Claude Code and Codex, announce the edit with its diff, then ask about it by reference.
                        const toolCallId = crypto.randomUUID();
                        await onSessionUpdate({
                            sessionId,
                            update: {
                                sessionUpdate: "tool_call",
                                toolCallId,
                                kind: "edit",
                                status: "pending",
                                title: "Edit src/todo.ts",
                                rawInput: {
                                    file_path: "src/todo.ts",
                                    old_string: "  return list.length;",
                                    new_string: "  const next = list.length + 1;\n  return next;",
                                    replace_all: false,
                                },
                                content: [
                                    {
                                        type: "diff",
                                        path: "src/todo.ts",
                                        oldText: "  return list.length;",
                                        newText: "  const next = list.length + 1;\n  return next;",
                                    },
                                ],
                                locations: [{ path: "src/todo.ts" }],
                            },
                        });
                        const edit = await context.client.request(
                            acp.methods.client.session.requestPermission,
                            { sessionId, toolCall: { toolCallId, title: "Edit src/todo.ts" }, options },
                            { cancellationSignal: signal },
                        );
                        await onSessionUpdate({
                            sessionId,
                            update: {
                                sessionUpdate: "agent_message_chunk",
                                messageId: crypto.randomUUID(),
                                content: {
                                    type: "text",
                                    text: `Edit decision: ${edit.outcome.outcome === "selected" ? edit.outcome.optionId : "cancelled"}`,
                                },
                            },
                        });
                        return { stopReason: "end_turn" };
                    }
                    const permission = await context.client.request(
                        acp.methods.client.session.requestPermission,
                        {
                            sessionId,
                            toolCall: {
                                toolCallId: crypto.randomUUID(),
                                kind: planMode ? "switch_mode" : "execute",
                                status: "pending",
                                title: planMode
                                    ? "Enter plan mode"
                                    : longPermission
                                      ? `Read ${longPath}`
                                      : "Run verification",
                                rawInput: planMode
                                    ? { mode: "plan" }
                                    : context.params.prompt.some(
                                            (content) =>
                                                content.type === "text" &&
                                                content.text === "request without tool input",
                                        )
                                      ? undefined
                                      : {
                                            command: longPermission
                                                ? `pnpm inspect ${longPath} --reporter=verbose`
                                                : "pnpm test -- --reporter=verbose",
                                            target: "src/<entry>.ts",
                                        },
                                locations: planMode ? [] : [{ path: "src/<entry>.ts", line: 12 }],
                            },
                            options,
                        },
                        { cancellationSignal: signal },
                    );
                    let text = "Permission cancelled";
                    if (permission.outcome.outcome === "selected") {
                        if (sessionScope) {
                            text = `Selected decision: ${permission.outcome.optionId}`;
                        } else if (permission.outcome.optionId === "reject") {
                            text = planMode ? "Selected decision: No, start implementing now" : "Permission rejected";
                        } else {
                            const input = await context.client.request(
                                acp.methods.client.elicitation.create,
                                {
                                    sessionId,
                                    mode: "form",
                                    message: "Choose a branch to verify",
                                    requestedSchema: {
                                        type: "object",
                                        properties: { branch: { type: "string", title: "Branch", minLength: 1 } },
                                        required: ["branch"],
                                    },
                                },
                                { cancellationSignal: signal },
                            );
                            text = `Input ${input.action}`;
                            if (
                                input.action === "accept" &&
                                typeof input.content === "object" &&
                                input.content !== null &&
                                !Array.isArray(input.content)
                            ) {
                                const branch = Reflect.get(input.content, "branch");
                                if (typeof branch === "string") {
                                    text = `Selected branch: ${branch}`;
                                }
                            }
                        }
                    }
                    await onSessionUpdate({
                        sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            messageId: crypto.randomUUID(),
                            content: { type: "text", text },
                        },
                    });
                    return { stopReason: "end_turn" };
                } catch (cause) {
                    if (signal.aborted) {
                        return { stopReason: "cancelled" };
                    }
                    throw cause;
                } finally {
                    turns.delete(sessionId);
                }
            })
            .onNotification(acp.methods.agent.session.cancel, (context) => turns.get(context.params.sessionId)?.abort())
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
        "interaction-test",
        "Interaction Agent",
        process.execPath,
        {},
        "controlled-harness",
        fakeHarnessCapabilities,
    );
}
