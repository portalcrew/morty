import { pathToFileURL } from "node:url";
import type {
    ContentBlock,
    ToolCall,
    ToolCallContent,
    ToolCallStatus,
    ToolCallUpdate,
    ToolKind,
} from "@agentclientprotocol/sdk/unstable";
import type { AgentQuestion } from "@portalcrew/morty-client/protocol";
import { z } from "zod";
import { type ThreadItem, threadItemSchema } from "./app-server-protocol.ts";

const TOOL_OUTPUT_CHARACTER_LIMIT = 32_768;
const TITLE_CHARACTER_LIMIT = 500;
// Morty reads this key in its activity tracker to split streamed commentary from the final answer.
// It is a Morty-internal convention, not an app-server field.

function truncate(value: string, limit: number): string {
    return value.length <= limit ? value : value.slice(0, limit);
}

function boundedParagraphs(values: readonly string[], limit: number): string {
    let text = "";
    for (const value of values) {
        const separator = text.length === 0 ? "" : "\n\n";
        const remaining = limit - text.length;
        if (remaining <= separator.length) {
            break;
        }
        text += `${separator}${value.slice(0, remaining - separator.length)}`;
    }
    return text;
}

function textContent(text: string): ToolCallContent {
    const block: ContentBlock = { text: truncate(text, TOOL_OUTPUT_CHARACTER_LIMIT), type: "text" };
    return { content: block, type: "content" };
}

function structuredToolText(value: unknown): readonly ToolCallContent[] {
    const result = z.object({ content: z.array(z.unknown()) }).safeParse(value);
    const items = Array.isArray(value) ? value : result.success ? result.data.content : [];
    return items.flatMap((item) => {
        const text = z.object({ type: z.enum(["text", "inputText"]), text: z.string() }).safeParse(item);
        return text.success ? [textContent(text.data.text)] : [];
    });
}

function firstLine(value: string): string {
    const line = value.split("\n", 1)[0] ?? "";
    return line.trim().length > 0 ? line.trim() : value.trim();
}

interface ToolCallPresentation {
    readonly kind: ToolKind;
    readonly status: ToolCallStatus;
    readonly title: string;
    readonly content: readonly ToolCallContent[];
    readonly rawInput: unknown;
    readonly rawOutput: unknown;
    readonly locations: readonly { readonly path: string }[];
}

function commandStatus(status: "inProgress" | "completed" | "failed" | "declined"): ToolCallStatus {
    if (status === "inProgress") {
        return "in_progress";
    }
    return status === "completed" ? "completed" : "failed";
}

function patchStatus(status: "inProgress" | "completed" | "failed" | "declined"): ToolCallStatus {
    if (status === "inProgress") {
        return "in_progress";
    }
    return status === "completed" ? "completed" : "failed";
}

function mcpStatus(status: "inProgress" | "completed" | "failed"): ToolCallStatus {
    return status === "inProgress" ? "in_progress" : status === "completed" ? "completed" : "failed";
}

function collaborationStatus(status: "inProgress" | "completed" | "failed" | "interrupted"): ToolCallStatus {
    return status === "inProgress" ? "in_progress" : status === "completed" ? "completed" : "failed";
}

function presentToolItem(item: ThreadItem): ToolCallPresentation | null {
    if (item.type === "imageView") {
        return {
            content: [
                {
                    type: "content",
                    content: { type: "image", data: "", mimeType: "", uri: pathToFileURL(item.path).href },
                },
            ],
            kind: "read",
            locations: [{ path: item.path }],
            rawInput: { path: item.path },
            rawOutput: null,
            status: "completed",
            title: "View image",
        };
    }
    if (item.type === "imageGeneration") {
        const failed = item.failure != null || item.status === "failed";
        const content: ToolCallContent[] = [];
        if (!failed && item.result.length > 0) {
            // Structured media goes through the same hash-backed reverse-read path as ACP images.
            // Never include the base64 in rawOutput or in a text tool result.
            content.push({ type: "content", content: { type: "image", data: item.result, mimeType: "image/png" } });
        }
        if (failed) {
            content.push(
                textContent(
                    item.failure?.type === "usageLimitExceeded"
                        ? "Image generation usage limit reached."
                        : "Image generation failed.",
                ),
            );
        }
        return {
            content,
            kind: "other",
            locations: [],
            rawInput: item.revisedPrompt == null ? null : { prompt: item.revisedPrompt },
            rawOutput: null,
            status: failed ? "failed" : item.status === "completed" ? "completed" : "in_progress",
            title: "Generate image",
        };
    }
    if (item.type === "commandExecution") {
        const output = item.aggregatedOutput ?? "";
        const content: ToolCallContent[] = [];
        if (output.length > 0) {
            content.push(textContent(output));
        }
        if (item.exitCode != null && item.exitCode !== 0) {
            content.push(textContent(`Exit code ${item.exitCode}`));
        }
        return {
            content,
            kind: "execute",
            locations: [],
            rawInput: { command: item.command, cwd: item.cwd },
            rawOutput: {
                ...(item.exitCode == null ? {} : { exitCode: item.exitCode }),
                output: truncate(output, TOOL_OUTPUT_CHARACTER_LIMIT),
            },
            status: commandStatus(item.status),
            title: truncate(firstLine(item.command), TITLE_CHARACTER_LIMIT),
        };
    }
    if (item.type === "fileChange") {
        const paths = item.changes.map((change) => change.path);
        const content: ToolCallContent[] = item.changes.map((change) => ({
            newText: truncate(change.diff, TOOL_OUTPUT_CHARACTER_LIMIT),
            path: change.path,
            type: "diff",
        }));
        return {
            content,
            kind: "edit",
            locations: paths.map((path) => ({ path })),
            rawInput: { changes: item.changes.map((change) => change.path) },
            rawOutput: null,
            status: patchStatus(item.status),
            title: truncate(paths.join(", "), TITLE_CHARACTER_LIMIT),
        };
    }
    if (item.type === "mcpToolCall") {
        const label = `${item.server}/${item.tool}`;
        const content = structuredToolText(item.error ?? item.result);
        return {
            content,
            kind: "other",
            locations: [],
            rawInput: item.arguments ?? null,
            rawOutput: item.error ?? item.result ?? null,
            status: mcpStatus(item.status),
            title: truncate(label, TITLE_CHARACTER_LIMIT),
        };
    }
    if (item.type === "dynamicToolCall") {
        const label = item.namespace == null ? item.tool : `${item.namespace}/${item.tool}`;
        const content = structuredToolText(item.contentItems);
        return {
            content,
            kind: "other",
            locations: [],
            rawInput: item.arguments ?? null,
            rawOutput: item.contentItems ?? null,
            status: mcpStatus(item.status),
            title: truncate(label, TITLE_CHARACTER_LIMIT),
        };
    }
    if (item.type === "collabAgentToolCall") {
        const spawn = item.tool === "spawnAgent";
        return {
            content: [],
            kind: "other",
            locations: [],
            rawInput: spawn
                ? {
                      model: item.model,
                      prompt: item.prompt,
                      reasoningEffort: item.reasoningEffort,
                      senderThreadId: item.senderThreadId,
                  }
                : { receiverThreadIds: item.receiverThreadIds, senderThreadId: item.senderThreadId },
            rawOutput: {
                agentsStates: item.agentsStates,
                ...(spawn ? { receiverThreadIds: item.receiverThreadIds } : {}),
            },
            status: collaborationStatus(item.status),
            title: spawn ? "Dispatch subagent" : "Wait for subagent",
        };
    }
    if (item.type === "subAgentActivity" && item.kind === "started") {
        return {
            content: [],
            kind: "other",
            locations: [],
            rawInput: { agentPath: item.agentPath },
            rawOutput: { agentThreadId: item.agentThreadId },
            status: "in_progress",
            title: truncate(`Dispatch subagent ${item.agentPath}`, TITLE_CHARACTER_LIMIT),
        };
    }
    return null;
}

export function toolCallUpdate(
    item: ThreadItem,
    lifecycle: "snapshot" | "started" | "completed",
): (ToolCall & ToolCallUpdate) | null {
    const presentation = presentToolItem(item);
    if (presentation === null) {
        return null;
    }
    return {
        content: item.type === "imageView" && lifecycle === "started" ? [] : [...presentation.content],
        kind: presentation.kind,
        locations: [...presentation.locations],
        rawInput: presentation.rawInput,
        rawOutput: presentation.rawOutput,
        ...(item.type === "collabAgentToolCall"
            ? { name: item.tool === "spawnAgent" ? "spawn_agent" : "wait_agent" }
            : item.type === "subAgentActivity"
              ? { name: "spawn_agent" }
              : {}),
        status:
            item.type === "imageView" && lifecycle === "started"
                ? "in_progress"
                : lifecycle === "completed" && presentation.status === "in_progress"
                  ? "completed"
                  : presentation.status,
        title: presentation.title,
        toolCallId: item.id,
    };
}

export function decodeThreadItem(value: unknown): ThreadItem | null {
    const decoded = threadItemSchema.safeParse(value);
    return decoded.success ? decoded.data : null;
}

export function messageQuestions(item: ThreadItem): readonly AgentQuestion[] {
    return item.type === "agentMessage"
        ? (item.questions ?? []).map((question) => ({ options: question.options ?? [], question: question.title }))
        : [];
}

export function reasoningText(item: ThreadItem): string | null {
    if (item.type !== "reasoning") {
        return null;
    }
    return boundedParagraphs(item.content.length > 0 ? item.content : item.summary, TOOL_OUTPUT_CHARACTER_LIMIT);
}
