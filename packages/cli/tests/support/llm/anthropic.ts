import { createServer, type ServerResponse } from "node:http";

import {
    countMatchingObjects,
    type FakeProviderScenario,
    fakeProviderPrompts,
    fakeProviderResponse,
    latestUserPrompt,
    responseChunks,
    type SubagentScript,
    selectFakeProviderScenario,
    selectSubagentDispatchTool,
} from "./scenarios.ts";

type JsonObject = Record<string, unknown>;

interface AnthropicTool {
    readonly inputSchema: JsonObject;
    readonly name: string;
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolResultCount(value: unknown): number {
    return countMatchingObjects(value, (object) => object["type"] === "tool_result");
}

function availableTools(payload: JsonObject): readonly AnthropicTool[] {
    if (!Array.isArray(payload["tools"])) {
        return [];
    }
    return payload["tools"].flatMap((tool) => {
        if (!isObject(tool) || typeof tool["name"] !== "string" || !isObject(tool["input_schema"])) {
            return [];
        }
        return [{ inputSchema: tool["input_schema"], name: tool["name"] }];
    });
}

function stringProperty(tool: AnthropicTool, candidates: readonly string[]): string | undefined {
    const properties = tool.inputSchema["properties"];
    if (!isObject(properties)) {
        return undefined;
    }
    return candidates.find((candidate) => isObject(properties[candidate]));
}

function selectTool(
    tools: readonly AnthropicTool[],
    scenario: FakeProviderScenario,
    completedToolCalls: number,
    readPath?: string,
    bash?: { readonly command: string; readonly runInBackground: boolean },
): { readonly id: string; readonly input: JsonObject; readonly name: string } | undefined {
    const id = `toolu_morty_${(completedToolCalls + 1).toString()}`;
    if (readPath !== undefined && tools.length > 0) {
        const read = tools.find((tool) => /(?:^|_)(?:read|read_file)$/iu.test(tool.name));
        if (read !== undefined) {
            const path = stringProperty(read, ["file_path", "filePath", "path", "file"]);
            if (path !== undefined) {
                return { id, input: { [path]: readPath }, name: read.name };
            }
        }
        throw new Error("The real Agent did not advertise a file reader");
    }
    const shell = tools.find((tool) => /(?:^|_)(?:bash|shell|command)$/iu.test(tool.name));
    if (shell !== undefined) {
        const command = stringProperty(shell, ["command", "cmd"]);
        if (command !== undefined) {
            return {
                id,
                input: {
                    [command]: bash?.command ?? scenario.command,
                    ...(bash === undefined ? {} : { run_in_background: bash.runInBackground }),
                },
                name: shell.name,
            };
        }
    }
    const read = tools.find((tool) => /(?:^|_)(?:read|read_file)$/iu.test(tool.name));
    if (read !== undefined) {
        const path = stringProperty(read, ["file_path", "filePath", "path", "file"]);
        if (path !== undefined) {
            return {
                id,
                input: { [path]: scenario.command === "false" ? "./morty-missing-file" : "." },
                name: read.name,
            };
        }
    }
    return undefined;
}

function message(model: string, content: readonly JsonObject[], stopReason: "end_turn" | "tool_use"): JsonObject {
    return {
        id: "msg_morty",
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 6 },
    };
}

/** One scripted step of the subagent round trip, keyed by the request's latest
 *  user prompt (the harness wraps it in system reminders, so the script's
 *  prompts are matched at the tail) and its completed tool-call count. The main
 *  thread's dispatch prompt with no completed calls emits the subagent dispatch
 *  tool; the inner prompt with no completed calls defers to the shell scenario
 *  (returns null); the inner prompt after its shell result reports in text; the
 *  dispatch prompt after the dispatch tool's result returns null so the default
 *  answer path applies. */
function subagentStep(
    script: SubagentScript,
    tools: readonly { readonly name: string }[],
    prompt: string,
    completedToolCalls: number,
):
    | {
          readonly text?: string;
          readonly tool?: { readonly id: string; readonly input: JsonObject; readonly name: string };
      }
    | undefined {
    if (prompt.endsWith(script.dispatchPrompt) && completedToolCalls === 0) {
        const dispatch = selectSubagentDispatchTool(tools);
        if (dispatch === undefined) {
            throw new Error("The real Agent did not advertise a subagent dispatch tool");
        }
        return {
            tool: {
                id: "toolu_morty_subagent",
                input: {
                    description: script.dispatchDescription,
                    prompt: script.innerPrompt,
                    ...(script.runInBackground ? { run_in_background: true, subagent_type: "general-purpose" } : {}),
                },
                name: dispatch.name,
            },
        };
    }
    if (prompt.endsWith(script.innerPrompt) && completedToolCalls > 0) {
        return { text: script.innerReport };
    }
    return undefined;
}

function event(response: ServerResponse, type: string, payload: JsonObject): void {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function sendStream(
    response: ServerResponse,
    model: string,
    content: JsonObject,
    chunks: readonly string[],
    stopReason: "end_turn" | "tool_use",
): void {
    response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
    });
    event(response, "message_start", {
        message: {
            ...message(model, [], stopReason),
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 1 },
        },
    });
    event(response, "content_block_start", {
        index: 0,
        content_block: content["type"] === "tool_use" ? { ...content, input: {} } : { type: "text", text: "" },
    });
    if (content["type"] === "tool_use") {
        event(response, "content_block_delta", {
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(content["input"]) },
        });
    } else {
        for (const chunk of chunks) {
            event(response, "content_block_delta", {
                index: 0,
                delta: { type: "text_delta", text: chunk },
            });
        }
    }
    event(response, "content_block_stop", { index: 0 });
    event(response, "message_delta", {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 6 },
    });
    event(response, "message_stop", {});
    response.end();
}

export class FakeAnthropicProvider implements AsyncDisposable {
    static readonly apiKey = "morty-agent-daemon-fixture";

    readonly model: string;
    readonly origin: string;
    readonly response: string;
    readonly #answer: string;
    readonly #close: () => Promise<void>;
    readonly #toolPrompts: readonly (string | undefined)[];

    private constructor(
        origin: string,
        model: string,
        answer: string,
        toolPrompts: readonly (string | undefined)[],
        close: () => Promise<void>,
    ) {
        this.origin = origin;
        this.model = model;
        this.#answer = answer;
        this.#toolPrompts = toolPrompts;
        this.response = fakeProviderResponse(answer, selectFakeProviderScenario(fakeProviderPrompts.successfulTool));
        this.#close = close;
    }

    responseFor(prompt: string): string {
        return fakeProviderResponse(this.#answer, selectFakeProviderScenario(prompt, this.#toolPrompts));
    }

    static async start(
        model: string,
        answer: string,
        options: {
            readonly beforeFirstText?: (
                scenario: FakeProviderScenario,
                signal: AbortSignal,
                conversation: string,
            ) => Promise<void>;
            readonly disconnectsBeforeSuccess?: number;
            readonly readPath?: string;
            /** The test prompt that runs the configured tool action (`readPath`,
             *  `bash`, or a shell command) once. */
            readonly toolPrompt?: string;
            readonly bash?: { readonly command: string; readonly runInBackground: boolean };
            readonly subagent?: SubagentScript;
        } = {},
    ): Promise<FakeAnthropicProvider> {
        // A subagent script's inner prompt is the subagent's tool prompt.
        const toolPrompts = [options.toolPrompt, options.subagent?.innerPrompt];
        let disconnectsRemaining = options.disconnectsBeforeSuccess ?? 0;
        const server = createServer(async (request, response) => {
            const disconnected = new AbortController();
            response.once("close", () => disconnected.abort());
            let body = "";
            for await (const chunk of request) {
                body += chunk.toString();
            }
            const decoded: unknown = body.length === 0 ? {} : JSON.parse(body);
            const payload = isObject(decoded) ? decoded : {};
            if (request.url?.endsWith("/messages/count_tokens") === true) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ input_tokens: 10 }));
                return;
            }
            if (disconnectsRemaining > 0) {
                disconnectsRemaining -= 1;
                response.destroy();
                return;
            }

            const tools = availableTools(payload);
            const completedToolCalls = toolResultCount(payload);
            const prompt = latestUserPrompt(payload);
            const scenario = selectFakeProviderScenario(prompt, toolPrompts);
            const scripted =
                options.subagent !== undefined
                    ? subagentStep(options.subagent, tools, prompt, completedToolCalls)
                    : undefined;
            const tool =
                scripted?.tool ??
                (completedToolCalls < scenario.toolCalls
                    ? selectTool(tools, scenario, completedToolCalls, options.readPath, options.bash)
                    : undefined);
            const selectedAnswer = scripted?.text ?? fakeProviderResponse(answer, scenario);
            const content =
                tool === undefined
                    ? { type: "text", text: selectedAnswer }
                    : { type: "tool_use", id: tool.id, name: tool.name, input: tool.input };
            const stopReason = tool === undefined ? "end_turn" : "tool_use";
            // Startup probes such as /api/hello are not model requests.
            if (tool === undefined && Array.isArray(payload["messages"])) {
                await options.beforeFirstText?.(scenario, disconnected.signal, JSON.stringify(payload["messages"]));
            }
            if (payload["stream"] === true) {
                sendStream(response, model, content, responseChunks(selectedAnswer, scenario), stopReason);
                return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(message(model, [content], stopReason)));
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            throw new Error("Fake Anthropic provider has no TCP address");
        }
        const close = async (): Promise<void> => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
        };
        return new FakeAnthropicProvider(
            `http://127.0.0.1:${address.port.toString()}`,
            model,
            answer,
            toolPrompts,
            close,
        );
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#close();
    }
}
