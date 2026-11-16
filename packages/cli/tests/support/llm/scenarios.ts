type JsonObject = Record<string, unknown>;

export interface FakeProviderScenario {
    readonly command: "false" | "pwd";
    readonly streamed: boolean;
    readonly toolCalls: number;
}

/** A scripted Task-tool round trip: the main thread dispatches a subagent, the
 *  subagent runs one shell tool and reports back, and the main thread then
 *  answers in text. The prompts are the conversation keys the fake provider
 *  distinguishes requests by (the subagent's conversation carries only its own
 *  prompt). */
export interface SubagentScript {
    readonly runInBackground?: boolean;
    readonly dispatchDescription: string;
    readonly dispatchPrompt: string;
    readonly innerPrompt: string;
    readonly innerReport: string;
}

/** The prompts that script shell tool calls. A request follows one of these
 *  scenarios only when its latest user message contains the prompt itself; any
 *  other request is answered with plain text. */
export const fakeProviderPrompts = {
    failedTool: "Use a shell tool that fails, then explain the result using the configured model",
    streamedTool: "Use a shell tool successfully, then stream a Unicode reply using the configured model",
    successfulTool: "Use a shell tool successfully, then reply using the configured model",
    twoTools: "Use two shell tools successfully, then reply using the configured model",
} as const;

const promptScenarios: readonly (readonly [string, FakeProviderScenario])[] = [
    [fakeProviderPrompts.failedTool, { command: "false", streamed: false, toolCalls: 1 }],
    [fakeProviderPrompts.streamedTool, { command: "pwd", streamed: true, toolCalls: 1 }],
    [fakeProviderPrompts.successfulTool, { command: "pwd", streamed: false, toolCalls: 1 }],
    [fakeProviderPrompts.twoTools, { command: "pwd", streamed: false, toolCalls: 2 }],
];

const toolPromptScenario: FakeProviderScenario = { command: "pwd", streamed: false, toolCalls: 1 };

const textScenario: FakeProviderScenario = { command: "pwd", streamed: false, toolCalls: 0 };

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(contentText).filter(Boolean).join("\n");
    }
    if (!isObject(value)) {
        return "";
    }
    for (const key of ["text", "content", "parts"] as const) {
        const text = contentText(value[key]);
        if (text.length > 0) {
            return text;
        }
    }
    return "";
}

function isToolResult(part: unknown): boolean {
    return isObject(part) && (part["type"] === "tool_result" || isObject(part["functionResponse"]));
}

function userText(message: JsonObject): string {
    for (const key of ["content", "parts"] as const) {
        const value = message[key];
        const text = contentText(Array.isArray(value) ? value.filter((part) => !isToolResult(part)) : value);
        if (text.length > 0) {
            return text;
        }
    }
    return "";
}

export function latestUserPrompt(value: unknown): string {
    if (!isObject(value)) {
        return "";
    }
    for (const key of ["messages", "input", "contents"] as const) {
        const items = value[key];
        if (typeof items === "string") {
            return items;
        }
        if (!Array.isArray(items)) {
            continue;
        }
        for (const item of [...items].reverse()) {
            if (!isObject(item) || !["user", "USER"].includes(String(item["role"]))) {
                continue;
            }
            const text = userText(item);
            if (text.length > 0) {
                return text;
            }
        }
        const text = contentText(items);
        if (text.length > 0) {
            return text;
        }
    }
    return "";
}

/** Whether a request's latest user message carries a prompt the test sent. Real
 *  Agents add their own text to user messages (Claude Code prefixes the user's
 *  text with system reminders, and attachments append links), so the prompt is
 *  found within the message rather than compared with all of it. */
export function carriesPrompt(message: string, prompt: string | undefined): boolean {
    return prompt !== undefined && message.includes(prompt);
}

/** Selects the scenario for a request from its latest user message. Only prompts
 *  a test states select tool calls: the provider's configured tool prompts and
 *  `fakeProviderPrompts`. Every other message, including user-role text an Agent
 *  injects itself (system reminders, task notifications, environment context),
 *  is answered with plain text, so its wording can never script a tool call. */
export function selectFakeProviderScenario(
    message: string,
    toolPrompts: readonly (string | undefined)[] = [],
): FakeProviderScenario {
    if (toolPrompts.some((prompt) => carriesPrompt(message, prompt))) {
        return toolPromptScenario;
    }
    return promptScenarios.find(([prompt]) => carriesPrompt(message, prompt))?.[1] ?? textScenario;
}

export function fakeProviderResponse(base: string, scenario: FakeProviderScenario): string {
    const toolResult =
        scenario.toolCalls === 0
            ? "plain response"
            : scenario.command === "false"
              ? "failed tool result observed"
              : scenario.toolCalls === 2
                ? "two tool results observed"
                : "tool result observed";
    return `${base}: ${toolResult}${scenario.streamed ? " — streamed Unicode: héllo 🌍" : ""}`;
}

export function responseChunks(response: string, scenario: FakeProviderScenario): readonly string[] {
    if (!scenario.streamed) {
        return [response];
    }
    const midpoint = Math.ceil(response.length / 2);
    return [response.slice(0, midpoint), response.slice(midpoint)];
}

export function countMatchingObjects(value: unknown, predicate: (object: JsonObject) => boolean): number {
    if (Array.isArray(value)) {
        return value.reduce((count, item) => count + countMatchingObjects(item, predicate), 0);
    }
    if (!isObject(value)) {
        return 0;
    }
    let count = predicate(value) ? 1 : 0;
    for (const item of Object.values(value)) {
        count += countMatchingObjects(item, predicate);
    }
    return count;
}

export function selectSubagentDispatchTool(
    tools: readonly { readonly name: string }[],
): { readonly name: string } | undefined {
    return tools.find((tool) => /^(?:task|agent)$/iu.test(tool.name));
}
