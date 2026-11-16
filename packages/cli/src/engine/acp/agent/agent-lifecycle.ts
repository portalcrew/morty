import type { LifecycleMetadata } from "@portalcrew/morty-client/protocol";
import { AcpExecutionError } from "../acp-error.ts";

export type AgentTermination =
    | { readonly kind: "closed" }
    | { readonly kind: "failed"; readonly error: AcpExecutionError };

export function agentTerminationError(termination: AgentTermination): AcpExecutionError {
    switch (termination.kind) {
        case "failed":
            return termination.error;
        case "closed":
            // Retain the public failure code independently of the Agent's transport.
            return new AcpExecutionError("The ACP endpoint is closed", {}, "acp_endpoint_closed");
        default: {
            const unreachable: never = termination;
            return unreachable;
        }
    }
}

export type BackgroundActivity = "none" | "running" | "awaiting-results";

export type PromptDelegationStage = Extract<LifecycleMetadata, { readonly kind: "prompt.delegated" }>["stage"];
