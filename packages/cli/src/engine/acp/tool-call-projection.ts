import type { AcpSessionUpdate } from "@portalcrew/morty-client/protocol";

/**
 * A tool call as the event history projection currently holds it: either the
 * original announcement or the announcement with later ACP tool call updates
 * already merged into it. The projection owns the merge; readers only see the
 * resulting state.
 */
export type ProjectedToolCall = Extract<AcpSessionUpdate, { readonly sessionUpdate: "tool_call" | "tool_call_update" }>;
