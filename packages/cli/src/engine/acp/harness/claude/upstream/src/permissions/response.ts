// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

import type { PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk/unstable";
import type { PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { applyClaudePermissionSelection, parseClaudePermissionSelection } from "./effects.js";
import type { DurablePermissionChangeSet } from "./normalization.js";

export interface ClaudePermissionDecision {
    permissionResult: PermissionResult;
    contextResetMode?: PermissionMode;
}

/** Decode, validate, and interpret an ACP response exactly once. */
export function decodeClaudePermissionResponse(
    response: RequestPermissionResponse,
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string,
    offeredOptions: readonly PermissionOption[],
    durableChangeSet?: DurablePermissionChangeSet,
): ClaudePermissionDecision {
    const selection = parseClaudePermissionSelection(response, toolName);
    const offeredOption = offeredOptions.find((option) => option.optionId === selection.optionId);
    if (!offeredOption) {
        throw new Error(`Permission option was not offered: ${selection.optionId}`);
    }
    const permissionResult = applyClaudePermissionSelection(selection, {
        toolName,
        input,
        toolUseID,
        durableChangeSet,
    });
    return {
        permissionResult,
        ...(selection.contextResetMode ? { contextResetMode: selection.contextResetMode } : {}),
    };
}
