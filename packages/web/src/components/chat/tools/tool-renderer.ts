import type { SessionToolPresentation } from "./tool-contract.ts";

export type ToolCallState = SessionToolPresentation["state"];
export type ToolThinkingEntry = SessionToolPresentation;

export interface ToolRendererProps {
    readonly entry: ToolThinkingEntry;
}
