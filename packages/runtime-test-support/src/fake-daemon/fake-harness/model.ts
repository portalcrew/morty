import type { ToolCallContent } from "@agentclientprotocol/sdk/unstable";
import type { AgentQuestion } from "@morty-build/client/protocol";
import type { PromptDelegationStage } from "../../../../cli/src/engine/acp/agent/agent-lifecycle.ts";

export type HarnessOutput =
    | {
          readonly kind: "message";
          readonly text: string;
          /** Questions the message asks while the Agent keeps working, as Codex sends them. */
          readonly questions?: readonly AgentQuestion[];
      }
    /** Reports the prompt as handed to another client that owns the native session, as Codex does for the Codex app. */
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
          /** Opens a compaction (in_progress) that a later compaction-finish
           *  output settles; other outputs may interleave between them. */
          readonly kind: "compaction-start";
      }
    | {
          /** Settles the compaction opened by compaction-start, streaming the
           *  summary as one chunk before the terminal update. */
          readonly kind: "compaction-finish";
          readonly summary: string;
      }
    | {
          /** Streams no chunks; the terminal completed update carries the summary
           *  as an array of content blocks, exercising the replacement patch. */
          readonly kind: "compaction-summary-blocks";
          readonly blocks: readonly string[];
      }
    | {
          /** Pushes agent-side config options as a config_option_update, including an explicit empty list. */
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
    readonly echoUserMessage?: boolean;
    readonly sessionIds?: ReadonlySet<string>;
    readonly reply: (prompt: string, turnNumber: number, mode: "prompt" | "steer") => HarnessReplyPlan;
}
