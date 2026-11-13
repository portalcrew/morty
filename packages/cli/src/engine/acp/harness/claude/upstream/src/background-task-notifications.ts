// Modified for Morty.
// Part of the Claude ACP adapter derived from Zed Industries' claude-code-acp (Apache-2.0).

import type { ToolCallStatus } from "@agentclientprotocol/sdk/unstable";
import type { ClaudeSessionNotification as SessionNotification } from "./session-update.js";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "unknown";
export interface BackgroundTaskNotification {
    readonly id: string;
    readonly toolUseId?: string;
    readonly status: BackgroundTaskStatus;
    readonly summary: string;
}

/** Only native provenance identifies a task notification; matching user text is ordinary user input. */
export function isTaskNotificationOrigin(origin: unknown): boolean {
    return (
        typeof origin === "object" &&
        origin !== null &&
        "kind" in origin &&
        origin.kind === "task-notification" &&
        !("subkind" in origin)
    );
}

export function parseTaskNotifications(content: unknown, fallbackId: string): readonly BackgroundTaskNotification[] {
    const text =
        typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                    .flatMap((block: unknown) =>
                        typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
                            ? [block.text]
                            : [],
                    )
                    .join("\n")
              : "";
    return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/gu)].map((match, index) => {
        const body = match[1] ?? "";
        const id = /<task-id>([^<>]{1,255})<\/task-id>/u.exec(body)?.[1] ?? `${fallbackId}-${index}`;
        const toolUseId = /<tool-use-id>([^<>]{1,255})<\/tool-use-id>/u.exec(body)?.[1];
        const value = /<status>([^<>]+)<\/status>/u.exec(body)?.[1];
        const status = value === "completed" || value === "failed" || value === "stopped" ? value : "unknown";
        const summary =
            /<summary>([\s\S]*?)<\/summary>/u.exec(body)?.[1]?.slice(0, 10_000) ?? "Background task status unavailable";
        return { id, ...(toolUseId === undefined ? {} : { toolUseId }), status, summary };
    });
}

export function backgroundTaskUpdate(task: BackgroundTaskNotification, linked: boolean): SessionNotification["update"] {
    const status: ToolCallStatus | undefined =
        task.status === "completed"
            ? "completed"
            : task.status === "running"
              ? "in_progress"
              : task.status === "unknown"
                ? undefined
                : "failed";
    const fields = {
        toolCallId: task.toolUseId ?? `claude-task-${task.id}`,
        _meta: { "morty.backgroundTask": { id: task.id, status: task.status } },
        ...(status === undefined ? {} : { status }),
        content: [{ type: "content", content: { type: "text", text: task.summary } }],
    } satisfies Omit<Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>, "sessionUpdate">;
    return linked
        ? { ...fields, sessionUpdate: "tool_call_update" }
        : { ...fields, sessionUpdate: "tool_call", kind: "execute", title: "Background task" };
}

export function backgroundTaskId(result: unknown): string | undefined {
    return typeof result === "object" &&
        result !== null &&
        "backgroundTaskId" in result &&
        typeof result.backgroundTaskId === "string" &&
        result.backgroundTaskId.length > 0
        ? result.backgroundTaskId
        : undefined;
}
