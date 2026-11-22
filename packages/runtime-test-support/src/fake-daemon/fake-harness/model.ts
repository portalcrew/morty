import type { AvailableCommand, ToolCallContent } from "@agentclientprotocol/sdk/unstable";
import type { AgentQuestion } from "@portalcrew/morty-client/protocol";
import type { PromptDelegationStage } from "../../../../cli/src/engine/acp/agent/agent-lifecycle.ts";

export type HarnessOutput =
    | {
          readonly kind: "message";
          readonly text: string;
          readonly questions?: readonly AgentQuestion[];
      }
    | { readonly kind: "delegation"; readonly stage: PromptDelegationStage }
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "file"; readonly name: string }
    | { readonly kind: "session-title"; readonly title: string }
    | { readonly kind: "session-updated-at"; readonly updatedAt: string }
    | {
          readonly kind: "compaction";
          readonly summary: string;
      }
    | {
          readonly kind: "compaction-start";
      }
    | {
          readonly kind: "compaction-finish";
          readonly summary: string;
      }
    | {
          readonly kind: "compaction-summary-blocks";
          readonly blocks: readonly string[];
      }
    | {
          readonly kind: "agent-config";
          readonly configOptions: readonly import("@agentclientprotocol/sdk/unstable").SessionConfigOption[];
      }
    | {
          readonly kind: "activity";
          readonly title: string;
          readonly output: string;
          readonly activityType: "reasoning";
      }
    | {
          readonly kind: "activity";
          readonly title: string;
          readonly output: string;
          readonly activityType: "tool";
          readonly content: readonly ToolCallContent[];
      };

export interface HarnessReplyPlan {
    readonly output: readonly HarnessOutput[];
    readonly outcome: "hold" | "complete";
}

export interface FakeAgentHarnessOptions {
    readonly harness?: string;
    readonly agentName?: string;
    readonly additionalAgents?: readonly { readonly harness: string; readonly name: string }[];
    readonly commands?: readonly AvailableCommand[];
    readonly echoUserMessage?: boolean;
    readonly sessionIds?: ReadonlySet<string>;
    readonly nativeSessionPageSize?: number;
    readonly beforeNativeSessionPage?: (cursor: string | null) => Promise<void>;
    readonly beforeSessionLoaded?: ((sessionId: string) => Promise<void>) | undefined;
    readonly reply: (prompt: string, turnNumber: number, mode: "prompt" | "steer") => HarnessReplyPlan;
}
