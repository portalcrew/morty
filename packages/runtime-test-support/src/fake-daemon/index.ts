import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { AgentConnectionOptions } from "../../../cli/tests/support/agents/agent-connection.ts";
import { createControlledAgent } from "../../../cli/tests/support/agents/controlled-agent-definition.ts";
import { ControlledEndpointConnection } from "./controlled-connection.ts";
import { createFakeHarness, fakeHarnessCapabilities } from "./fake-harness/index.ts";
import type { FakeAgentHarnessOptions } from "./fake-harness/model.ts";

export type ControlledSessionUpdate = (notification: SessionNotification) => Promise<void>;

/** Adapts the controlled ACP peer to the same awaited update port used by native Agents. */
export const controlledSessionUpdates =
    (client: AgentConnectionOptions["client"]): ControlledSessionUpdate =>
    async (notification) => {
        const update = notification.update;
        switch (update.sessionUpdate) {
            case "user_message_chunk":
            case "agent_message_chunk":
            case "agent_thought_chunk":
                if (typeof update.messageId !== "string" || update.messageId.length === 0) {
                    throw new Error("The controlled ACP peer must identify message chunks");
                }
                await client.onUpdate({ ...notification, update: { ...update, messageId: update.messageId } });
                break;
            default:
                await client.onUpdate({ ...notification, update });
        }
    };

export { type ControlledAcpPeer, ControlledEndpointConnection } from "./controlled-connection.ts";

/** Composes the production daemon's injected Agent type with a controlled ACP harness. */
export function createFakeDaemon(options: FakeAgentHarnessOptions) {
    const harness = createFakeHarness(options);
    return {
        agents: harness.agents.map((agent) =>
            createControlledAgent(
                (options) =>
                    new ControlledEndpointConnection(
                        agent.createEndpoint(
                            controlledSessionUpdates(options.client),
                            async (stage) => await options.onPromptDelegation?.(stage),
                        ),
                        options.client,
                    ),
                agent.harness,
                agent.name,
                process.execPath,
                {},
                "controlled-harness",
                fakeHarnessCapabilities,
            ),
        ),
        catalog: harness.catalog,
        continueReply: harness.continueReply,
    };
}

export type { FakeAgentHarnessOptions, HarnessOutput, HarnessReplyPlan } from "./fake-harness/model.ts";
export { fakeHarnessCapabilities };
