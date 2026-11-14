import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {
    type ControlledAcpPeer,
    ControlledEndpointConnection,
    type ControlledSessionUpdate,
    controlledSessionUpdates,
    fakeHarnessCapabilities,
} from "@morty-build/runtime-test-support/fake-daemon";
import type { AcpAgentDefinition } from "../../../packages/cli/src/engine/acp/agent/agent-definition.ts";
import type { AgentTermination } from "../../../packages/cli/src/engine/acp/agent/agent-lifecycle.ts";
import { createControlledAgent } from "../../../packages/cli/tests/support/agents/controlled-agent-definition.ts";

/** Like Claude Code, a new session starts with the model its working directory's `.claude/settings.json` names. */
async function projectModel(cwd: string): Promise<string | undefined> {
    let settings: unknown;
    try {
        settings = JSON.parse(await readFile(join(cwd, ".claude", "settings.json"), "utf8"));
    } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
            return undefined;
        }
        throw cause;
    }
    const model: unknown =
        typeof settings === "object" && settings !== null ? Reflect.get(settings, "model") : undefined;
    return typeof model === "string" ? model : undefined;
}

/** Registers an in-process ACP Agent with the daemon. */
const defineAgent = (
    id: string,
    label: string,
    createEndpoint: (onSessionUpdate: ControlledSessionUpdate) => ControlledAcpPeer,
    version = "controlled-harness",
): AcpAgentDefinition =>
    createControlledAgent(
        (options) =>
            new ControlledEndpointConnection(createEndpoint(controlledSessionUpdates(options.client)), options.client),
        id,
        label,
        process.execPath,
        {},
        version,
        fakeHarnessCapabilities,
    );

/**
 * A stateful Agent with one model setting. Asked to "Remove settings", it removes
 * its configuration through a real ACP update; it answers any other prompt.
 */
export function createSettingsAgent(
    profile: "model" | "full" | "dependent" | "diagnostics" = "model",
    beforeConfigurationApplied?: (configId: string, value: string | boolean) => Promise<void>,
    beforeSessionCreated?: () => Promise<void>,
    beforeSessionsListed?: (signal: AbortSignal) => Promise<void>,
) {
    const sessions = new Map<string, acp.SessionConfigOption[]>();
    const histories = new Map<string, acp.SessionUpdate[]>();
    const configuration = (sessionId: string): acp.SessionConfigOption[] => {
        const options = sessions.get(sessionId);
        if (options === undefined) {
            throw new Error("Unknown controlled settings session");
        }
        return options;
    };
    const createEndpoint = (onSessionUpdate: ControlledSessionUpdate): ControlledAcpPeer => {
        const termination = Promise.withResolvers<AgentTermination>();
        const app = acp
            .agent({ name: "morty-settings-agent" })
            .onRequest(acp.methods.agent.initialize, () => ({
                agentCapabilities: { loadSession: true, sessionCapabilities: { close: {}, list: {}, resume: {} } },
                agentInfo: {
                    name: "Settings Agent",
                    version: profile === "diagnostics" ? "0.153.4" : "controlled-harness",
                },
                authMethods: [],
                protocolVersion: acp.PROTOCOL_VERSION,
            }))
            .onRequest(acp.methods.agent.session.new, async (context) => {
                await beforeSessionCreated?.();
                const sessionId = crypto.randomUUID();
                histories.set(sessionId, []);
                sessions.set(sessionId, [
                    {
                        id: "model",
                        name: "Model",
                        category: "model",
                        type: "select",
                        currentValue: (await projectModel(context.params.cwd)) ?? "test-small",
                        options: [
                            { value: "test-small", name: "Test Small" },
                            { value: "test-large", name: "Test Large" },
                            ...(profile !== "model"
                                ? Array.from({ length: 20 }, (_, index) => ({
                                      value: `test-model-${index}`,
                                      name: `Test model ${index} with a descriptive name`,
                                  }))
                                : []),
                        ],
                    },
                ]);
                if (profile !== "model") {
                    sessions.set(sessionId, [
                        {
                            id: "mode",
                            name: "Mode",
                            type: "select",
                            currentValue: "default",
                            options: [
                                { value: "default", name: "Default" },
                                { value: "plan", name: "Plan" },
                            ],
                        },
                        ...configuration(sessionId),
                        {
                            id: "effort",
                            name: "Effort",
                            type: "select",
                            currentValue: "high",
                            options: [
                                { value: "high", name: "High" },
                                { value: "low", name: "Low" },
                            ],
                        },
                        { id: "fast", name: "Fast mode", type: "boolean", currentValue: false },
                    ]);
                }
                if (profile === "diagnostics") {
                    sessions.set(sessionId, [
                        {
                            id: "model",
                            name: "Model",
                            category: "model",
                            type: "select",
                            currentValue: "gpt-6-sol",
                            description: "PRIVATE_MODEL_DESCRIPTION",
                            options: [
                                { value: "gpt-6-sol", name: "GPT-6-Sol" },
                                { value: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
                                { value: "PRIVATE_DEPLOYMENT_NAME", name: "PRIVATE_MODEL_LABEL" },
                            ],
                        },
                    ]);
                }
                return { sessionId, configOptions: configuration(sessionId) };
            })
            .onRequest(acp.methods.agent.session.load, async (context) => {
                const sessionId = context.params.sessionId;
                for (const update of histories.get(sessionId) ?? []) {
                    await onSessionUpdate({ sessionId, update });
                }
                return { configOptions: configuration(sessionId) };
            })
            .onRequest(acp.methods.agent.session.resume, (context) => ({
                configOptions: configuration(context.params.sessionId),
            }))
            .onRequest(acp.methods.agent.session.setConfigOption, async (context) => {
                const { configId, value, sessionId } = context.params;
                await beforeConfigurationApplied?.(configId, value);
                const current = configuration(sessionId).find((option) => option.id === configId);
                if (current === undefined) {
                    throw new Error("Unknown controlled setting");
                }
                const options = configuration(sessionId).map((option) => {
                    // This Agent's plan mode constrains its model, as real settings can depend on one another.
                    if (
                        profile === "dependent" &&
                        configId === "mode" &&
                        value === "plan" &&
                        option.id === "model" &&
                        option.type === "select"
                    ) {
                        return { ...option, currentValue: "test-small" };
                    }
                    // Its effort levels belong to the selected model, so choosing a model resets the effort.
                    if (
                        profile === "dependent" &&
                        configId === "model" &&
                        option.id === "effort" &&
                        option.type === "select"
                    ) {
                        return { ...option, currentValue: "high" };
                    }
                    if (option.id !== configId) {
                        return option;
                    }
                    if (option.type === "boolean" && typeof value === "boolean") {
                        return { ...option, currentValue: value };
                    }
                    if (
                        option.type === "select" &&
                        typeof value === "string" &&
                        option.options.some((choice) => "value" in choice && choice.value === value)
                    ) {
                        return { ...option, currentValue: value };
                    }
                    throw new Error("Unknown controlled setting value");
                });
                sessions.set(sessionId, options);
                return { configOptions: options };
            })
            .onRequest(acp.methods.agent.session.list, async (context) => {
                await beforeSessionsListed?.(context.signal);
                return { sessions: [] };
            })
            .onRequest(acp.methods.agent.session.prompt, async (context) => {
                const sessionId = context.params.sessionId;
                const messageId = crypto.randomUUID();
                const replyId = crypto.randomUUID();
                configuration(sessionId);
                const prompt = context.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
                const history = histories.get(sessionId);
                if (history === undefined) {
                    throw new Error("Unknown controlled settings history");
                }
                for (const content of context.params.prompt) {
                    const update: acp.SessionUpdate = { sessionUpdate: "user_message_chunk", content, messageId };
                    history.push(update);
                    const notification: acp.SessionNotification = { sessionId, update };
                    await onSessionUpdate(notification);
                }
                if (prompt === "Wait for permission with current settings") {
                    const update: acp.SessionUpdate = {
                        sessionUpdate: "agent_message_chunk",
                        messageId: replyId,
                        content: { type: "text", text: "Waiting for permission with the original settings." },
                    };
                    history.push(update);
                    await onSessionUpdate({ sessionId, update });
                    const result = await context.client.request(
                        acp.methods.client.session.requestPermission,
                        {
                            sessionId,
                            options: [
                                { optionId: "allow", kind: "allow_once", name: "Allow" },
                                { optionId: "deny", kind: "reject_once", name: "Deny" },
                            ],
                            toolCall: {
                                toolCallId: crypto.randomUUID(),
                                title: "Write the proposed file",
                                kind: "edit",
                                status: "pending",
                            },
                        },
                        { cancellationSignal: context.signal },
                    );
                    const decision: acp.SessionUpdate = {
                        sessionUpdate: "agent_message_chunk",
                        messageId: replyId,
                        content: {
                            type: "text",
                            text: `Permission decision: ${result.outcome.outcome === "selected" ? result.outcome.optionId : "cancelled"}`,
                        },
                    };
                    history.push(decision);
                    await onSessionUpdate({ sessionId, update: decision });
                    return { stopReason: "end_turn" };
                }
                if (prompt === "hold with consecutive user messages") {
                    const update: acp.SessionUpdate = {
                        sessionUpdate: "user_message_chunk",
                        messageId: crypto.randomUUID(),
                        content: { type: "text", text: "[Request interrupted by user]" },
                    };
                    history.push(update);
                    const notification: acp.SessionNotification = { sessionId, update };
                    await onSessionUpdate(notification);
                    return { stopReason: "end_turn" };
                }
                if (prompt !== "Remove settings") {
                    const update: acp.SessionUpdate = {
                        sessionUpdate: "agent_message_chunk",
                        messageId: replyId,
                        content: {
                            type: "text",
                            text:
                                prompt === "Report current model"
                                    ? `Current model: ${configuration(sessionId).find((option) => option.id === "model")?.currentValue}`
                                    : prompt === "Report current settings"
                                      ? `Current settings: ${configuration(sessionId)
                                            .map((option) => `${option.id}=${option.currentValue}`)
                                            .join(", ")}`
                                      : `Settings Agent: ${prompt}`,
                        },
                    };
                    history.push(update);
                    await onSessionUpdate({ sessionId, update });
                    return { stopReason: "end_turn" };
                }
                sessions.set(sessionId, []);
                const updates: acp.SessionUpdate[] = [
                    { sessionUpdate: "config_option_update", configOptions: [] },
                    {
                        sessionUpdate: "agent_message_chunk",
                        messageId: replyId,
                        content: { type: "text", text: "Settings removed" },
                    },
                ];
                history.push(...updates);
                for (const update of updates) {
                    await onSessionUpdate({ sessionId, update });
                }
                return { stopReason: "end_turn" };
            })
            .onRequest(acp.methods.agent.session.close, () => ({}));
        return {
            app: () => app,
            terminated: termination.promise,
            initialize: async (signal) => signal.throwIfAborted(),
            close: async () => termination.resolve({ kind: "closed" }),
        };
    };
    const id =
        profile === "diagnostics"
            ? "diagnostics-test"
            : profile === "model"
              ? "settings-test"
              : profile === "full"
                ? "configuration-test"
                : "dependent-settings-test";
    return defineAgent(
        id,
        "Settings Agent",
        createEndpoint,
        profile === "diagnostics" ? "codex-cli 0.153.4" : "controlled-harness",
    );
}
