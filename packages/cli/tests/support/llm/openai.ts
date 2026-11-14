import { createServer, type ServerResponse } from "node:http";

import {
    carriesPrompt,
    countMatchingObjects,
    type FakeProviderScenario,
    fakeProviderPrompts,
    fakeProviderResponse,
    latestUserPrompt,
    responseChunks,
    selectFakeProviderScenario,
} from "./scenarios.ts";

type JsonObject = Record<string, unknown>;

interface AvailableTool {
    readonly kind: "custom" | "function";
    readonly name: string;
    readonly namespace?: string;
    readonly parameters: JsonObject | undefined;
}

interface SelectedTool extends AvailableTool {
    readonly callId: string;
    readonly input: string;
}

interface RequestedTool {
    readonly input: string;
    readonly name: string;
}

interface ProviderRequestDiagnostic {
    readonly model: unknown;
    readonly reasoning: unknown;
    readonly serviceTier: unknown;
    readonly scenario: FakeProviderScenario;
    readonly selectedTool: Readonly<Pick<SelectedTool, "kind" | "name">> | undefined;
    readonly toolResultCount: number;
    readonly tools: readonly Readonly<Pick<AvailableTool, "kind" | "name">>[];
    readonly url: string;
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTool(value: unknown, namespace = ""): readonly AvailableTool[] {
    if (!isObject(value)) {
        return [];
    }
    if (value["type"] === "namespace" && typeof value["name"] === "string" && Array.isArray(value["tools"])) {
        const prefix = namespace.length === 0 ? value["name"] : `${namespace}.${value["name"]}`;
        return value["tools"].flatMap((tool) => collectTool(tool, prefix));
    }
    const definition = isObject(value["function"]) ? value["function"] : value;
    const name = definition["name"];
    if (typeof name !== "string") {
        return [];
    }
    const qualifiedName = namespace.length === 0 ? name : `${namespace}.${name}`;
    return [
        {
            kind: value["type"] === "custom" ? "custom" : "function",
            name: qualifiedName,
            ...(namespace.length === 0 ? {} : { namespace }),
            parameters: isObject(definition["parameters"]) ? definition["parameters"] : undefined,
        },
    ];
}

function availableTools(payload: JsonObject): readonly AvailableTool[] {
    const direct = Array.isArray(payload["tools"]) ? payload["tools"].flatMap((tool) => collectTool(tool)) : [];
    const input = Array.isArray(payload["input"]) ? payload["input"] : [];
    const additional = input.flatMap((item) => {
        if (!isObject(item) || item["type"] !== "additional_tools" || !Array.isArray(item["tools"])) {
            return [];
        }
        return item["tools"].flatMap((tool) => collectTool(tool));
    });
    return [...direct, ...additional];
}

function toolResultCount(value: unknown): number {
    return countMatchingObjects(value, (object) => {
        const type = object["type"];
        return (
            object["role"] === "tool" ||
            type === "tool_result" ||
            type === "function_call_output" ||
            type === "custom_tool_call_output"
        );
    });
}

function stringProperty(parameters: JsonObject | undefined, candidates: readonly string[]): string | undefined {
    const properties = parameters?.["properties"];
    if (!isObject(properties)) {
        return undefined;
    }
    return candidates.find((candidate) => isObject(properties[candidate]));
}

function selectTool(
    tools: readonly AvailableTool[],
    scenario: FakeProviderScenario,
    completedToolCalls: number,
    patch?: string,
    readPath?: string,
    mcpImage = false,
): SelectedTool | undefined {
    const callId = `call_morty_${(completedToolCalls + 1).toString()}`;
    if ((readPath !== undefined || mcpImage) && tools.length > 0) {
        const exec = tools.find((tool) => tool.kind === "custom" && /(?:^|\.)exec$/u.test(tool.name));
        if (exec !== undefined) {
            return {
                ...exec,
                name: "exec",
                callId,
                input: mcpImage
                    ? 'const result = await tools.mcp__image_test__image({}); for (const part of result.content) { if (part.type === "image") image(part); else if (part.type === "text") text(part.text); }'
                    : `const cwd = await tools.exec_command({cmd:"pwd"}); const result = await tools.view_image({path:cwd.output.trim()+"/"+${JSON.stringify(readPath)}}); image(result.image_url);`,
            };
        }
        if (mcpImage) {
            const tool = tools.find((entry) => entry.name.includes("image_test"));
            if (tool === undefined) {
                throw new Error("The Agent did not expose the image MCP tool");
            }
            return { ...tool, callId, input: "{}" };
        }

        const read = tools.find((tool) => /(?:^|\.)(?:read|read_file)$/iu.test(tool.name));
        const path = stringProperty(read?.parameters, ["filePath", "path", "file"]);
        if (read === undefined || path === undefined) {
            throw new Error("The Agent did not expose a file-read tool");
        }
        return { ...read, callId, input: JSON.stringify({ [path]: readPath }) };
    }
    if (patch !== undefined) {
        const applyPatch = tools.find((tool) => /(?:^|\.)apply_patch$/u.test(tool.name) && tool.kind === "custom");
        if (applyPatch !== undefined) {
            return { ...applyPatch, callId, input: patch };
        }
    }
    const shell = tools.find((tool) =>
        /(?:^|\.)(?:terminal|exec|bash|shell|command|run_terminal_command)$/iu.test(tool.name),
    );
    if (shell !== undefined) {
        if (shell.kind === "custom") {
            return {
                kind: "custom",
                name: shell.name.slice(shell.name.lastIndexOf(".") + 1),
                parameters: undefined,
                callId,
                input:
                    patch !== undefined
                        ? `const result = await tools.apply_patch(${JSON.stringify(patch)}); text(result);`
                        : `const result = await tools.exec_command({ cmd: ${JSON.stringify(scenario.command)}, max_output_tokens: 1000 });\ntext(result.output);`,
            };
        }
        const command = stringProperty(shell.parameters, ["command", "cmd"]);
        if (command !== undefined) {
            const input: Record<string, string> = { [command]: scenario.command };
            const description = stringProperty(shell.parameters, ["description"]);
            if (description !== undefined) {
                input[description] = "Print the current working directory";
            }
            return { ...shell, callId, input: JSON.stringify(input) };
        }
    }

    const read = tools.find((tool) => /(?:^|\.)(?:read|read_file)$/iu.test(tool.name));
    if (read !== undefined && read.kind === "function") {
        const path = stringProperty(read.parameters, ["filePath", "path", "file"]);
        if (path !== undefined) {
            return {
                ...read,
                callId,
                input: JSON.stringify({ [path]: scenario.command === "false" ? "./morty-missing-file" : "." }),
            };
        }
    }
    return undefined;
}

function selectRequestedTool(tools: readonly AvailableTool[], requested: RequestedTool): SelectedTool {
    const tool = tools.find(
        (candidate) => candidate.name === requested.name || candidate.name.endsWith(`.${requested.name}`),
    );
    if (tool === undefined) {
        throw new Error(`The Agent did not expose the requested ${requested.name} tool`);
    }
    return {
        ...tool,
        name: requested.name,
        callId: `call_morty_${requested.name}`,
        input: requested.input,
    };
}

function responseHeaders(): Readonly<Record<string, string>> {
    return {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
    };
}

function completedResponse(model: string, output: readonly JsonObject[]): JsonObject {
    return {
        id: "resp_morty",
        object: "response",
        created_at: 0,
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model,
        output,
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: null, summary: null },
        store: false,
        temperature: null,
        text: { format: { type: "text" }, verbosity: "medium" },
        tool_choice: "auto",
        tools: [],
        top_p: null,
        truncation: "disabled",
        usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 6,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 16,
        },
        user: null,
        metadata: {},
    };
}

function responsesEvent(response: ServerResponse, type: string, sequenceNumber: number, payload: JsonObject): void {
    response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...payload })}\n\n`,
    );
}

function sendResponsesText(
    response: ServerResponse,
    model: string,
    answer: string,
    chunks: readonly string[],
    commentary?: string,
): void {
    const messages = [
        ...(commentary === undefined
            ? []
            : [{ phase: "commentary", text: commentary, chunks: [commentary.slice(0, 10), commentary.slice(10)] }]),
        { phase: "final_answer", text: answer, chunks },
    ];
    const output = messages.map((message, index) => ({
        id: `msg_morty_${index}`,
        type: "message",
        role: "assistant",
        status: "completed",
        phase: message.phase,
        content: [{ type: "output_text", text: message.text, annotations: [] }],
    }));
    const completed = completedResponse(model, output);
    let sequence = 0;
    responsesEvent(response, "response.created", sequence++, {
        response: { ...completed, status: "in_progress", output: [] },
    });
    for (const [index, message] of messages.entries()) {
        const item = output[index];
        if (item === undefined) {
            throw new Error("Missing provider message");
        }
        const location = { item_id: item.id, output_index: index, content_index: 0 };
        responsesEvent(response, "response.output_item.added", sequence++, {
            output_index: index,
            item: { ...item, content: [] },
        });
        responsesEvent(response, "response.content_part.added", sequence++, {
            ...location,
            part: { type: "output_text", text: "", annotations: [] },
        });
        for (const chunk of message.chunks) {
            responsesEvent(response, "response.output_text.delta", sequence++, { ...location, delta: chunk });
        }
        responsesEvent(response, "response.output_text.done", sequence++, { ...location, text: message.text });
        responsesEvent(response, "response.content_part.done", sequence++, { ...location, part: item.content[0] });
        responsesEvent(response, "response.output_item.done", sequence++, { output_index: index, item });
    }
    responsesEvent(response, "response.completed", sequence, { response: completed });
    response.end();
}

function sendResponsesToolCall(response: ServerResponse, model: string, tool: SelectedTool): void {
    const type = tool.kind === "custom" ? "custom_tool_call" : "function_call";
    const item = {
        id: "tool_morty",
        type,
        call_id: tool.callId,
        name: tool.name,
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        status: "completed",
        ...(tool.kind === "custom" ? { input: tool.input } : { arguments: tool.input }),
    };
    const completed = completedResponse(model, [item]);
    responsesEvent(response, "response.created", 0, { response: { ...completed, status: "in_progress", output: [] } });
    responsesEvent(response, "response.output_item.added", 1, {
        output_index: 0,
        item: { ...item, ...(tool.kind === "custom" ? { input: "" } : { arguments: "" }) },
    });
    if (tool.kind === "custom") {
        responsesEvent(response, "response.custom_tool_call_input.delta", 2, {
            item_id: item.id,
            output_index: 0,
            delta: tool.input,
        });
        responsesEvent(response, "response.custom_tool_call_input.done", 3, {
            item_id: item.id,
            output_index: 0,
            input: tool.input,
        });
    } else {
        responsesEvent(response, "response.function_call_arguments.delta", 2, {
            item_id: item.id,
            output_index: 0,
            delta: tool.input,
        });
        responsesEvent(response, "response.function_call_arguments.done", 3, {
            item_id: item.id,
            output_index: 0,
            arguments: tool.input,
        });
    }
    responsesEvent(response, "response.output_item.done", 4, { output_index: 0, item });
    responsesEvent(response, "response.completed", 5, { response: completed });
    response.end();
}

function chatChunk(response: ServerResponse, model: string, choices: unknown, usage?: unknown): void {
    response.write(
        `data: ${JSON.stringify({
            id: "chatcmpl-morty",
            object: "chat.completion.chunk",
            created: 0,
            model,
            choices,
            ...(usage === undefined ? {} : { usage }),
        })}\n\n`,
    );
}

function sendChatText(response: ServerResponse, model: string, chunks: readonly string[]): void {
    chunks.forEach((chunk, index) => {
        chatChunk(response, model, [
            {
                index: 0,
                delta: { ...(index === 0 ? { role: "assistant" } : {}), content: chunk },
                finish_reason: null,
            },
        ]);
    });
    chatChunk(response, model, [{ index: 0, delta: {}, finish_reason: "stop" }], {
        prompt_tokens: 10,
        completion_tokens: 6,
        total_tokens: 16,
    });
    response.end("data: [DONE]\n\n");
}

function sendChatToolCall(response: ServerResponse, model: string, tool: SelectedTool): void {
    chatChunk(response, model, [
        {
            index: 0,
            delta: {
                role: "assistant",
                tool_calls: [
                    {
                        index: 0,
                        id: tool.callId,
                        type: "function",
                        function: { name: tool.name, arguments: tool.input },
                    },
                ],
            },
            finish_reason: null,
        },
    ]);
    chatChunk(response, model, [{ index: 0, delta: {}, finish_reason: "tool_calls" }], {
        prompt_tokens: 10,
        completion_tokens: 6,
        total_tokens: 16,
    });
    response.end("data: [DONE]\n\n");
}

function sendChatCompletion(
    response: ServerResponse,
    model: string,
    answer: string,
    tool: SelectedTool | undefined,
): void {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
        JSON.stringify({
            id: "chatcmpl-morty",
            object: "chat.completion",
            created: 0,
            model,
            choices: [
                {
                    index: 0,
                    message:
                        tool === undefined
                            ? { role: "assistant", content: answer }
                            : {
                                  role: "assistant",
                                  content: null,
                                  tool_calls: [
                                      {
                                          id: tool.callId,
                                          type: "function",
                                          function: { name: tool.name, arguments: tool.input },
                                      },
                                  ],
                              },
                    finish_reason: tool === undefined ? "stop" : "tool_calls",
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
        }),
    );
}

export class FakeOpenAiProvider implements AsyncDisposable {
    static readonly apiKey = "morty-agent-daemon-fixture";

    readonly model: string;
    readonly origin: string;
    readonly response: string;
    readonly #answer: string;
    readonly #close: () => Promise<void>;
    readonly #requests: ProviderRequestDiagnostic[];
    readonly #toolPrompts: readonly (string | undefined)[];

    private constructor(
        origin: string,
        model: string,
        answer: string,
        toolPrompts: readonly (string | undefined)[],
        requests: ProviderRequestDiagnostic[],
        close: () => Promise<void>,
    ) {
        this.#answer = answer;
        this.#toolPrompts = toolPrompts;
        this.model = model;
        this.origin = origin;
        this.response = fakeProviderResponse(answer, selectFakeProviderScenario(fakeProviderPrompts.successfulTool));
        this.#requests = requests;
        this.#close = close;
    }

    diagnostics(): readonly ProviderRequestDiagnostic[] {
        return this.#requests;
    }

    responseFor(prompt: string): string {
        return fakeProviderResponse(this.#answer, selectFakeProviderScenario(prompt, this.#toolPrompts));
    }

    static async start(
        model: string,
        answer: string,
        options: {
            /** Receives the conversation the model was asked to continue. */
            readonly beforeFirstText?: (signal: AbortSignal, conversation: string) => Promise<void>;
            readonly commentary?: string;
            readonly patch?: string;
            readonly readPath?: string | ((prompt: string) => string);
            readonly mcpImage?: boolean;
            /** The test prompt that runs `toolSequence`, or else the configured tool
             *  action (`patch`, `readPath`, `mcpImage`, or a shell command) once. */
            readonly toolPrompt?: string;
            readonly toolSequence?: readonly RequestedTool[];
            /** Fails every request whose prompt contains this text (HTTP 500), for
             *  guard paths such as a compaction whose summarization call errors. */
            readonly failPromptContaining?: string;
            /** The provider error message returned for requests matched by
             *  `failPromptContaining`. */
            readonly failureMessage?: string;
            /** When set with `failPromptContaining`, only the first N matching
             *  requests fail; later matches are answered normally, so an
             *  agent-level retry of the same prompt can recover. */
            readonly failMatchCount?: number;
            /** Awaited before a request matched by `failPromptContaining` receives
             *  its failure, giving a test a window to act while the request is in
             *  flight (for example to steer the running turn). */
            readonly holdBeforeFailure?: () => Promise<void>;
        } = {},
    ): Promise<FakeOpenAiProvider> {
        const requests: ProviderRequestDiagnostic[] = [];
        const toolPrompts = [options.toolPrompt];
        let failedMarkerRequests = 0;
        const server = createServer(async (request, response) => {
            const disconnected = new AbortController();
            response.once("close", () => disconnected.abort());
            if (request.method === "GET" && request.url?.endsWith("/models") === true) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        object: "list",
                        data: [{ id: model, object: "model", created: 0, owned_by: "morty" }],
                    }),
                );
                return;
            }
            let body = "";
            for await (const chunk of request) {
                body += chunk.toString();
            }
            if (body.length === 0) {
                response.writeHead(404).end();
                return;
            }
            const decoded: unknown = JSON.parse(body);
            const payload = isObject(decoded) ? decoded : {};
            if (request.url?.endsWith("/chat/completions") !== true && request.url?.endsWith("/responses") !== true) {
                response.writeHead(404).end();
                return;
            }
            const tools = availableTools(payload);
            const completedToolCalls = toolResultCount(payload);
            const userPrompt = latestUserPrompt(payload);
            const conversation = JSON.stringify(payload["input"] ?? payload["messages"] ?? null);
            const requestedTool = carriesPrompt(userPrompt, options.toolPrompt)
                ? options.toolSequence?.[completedToolCalls]
                : undefined;
            const scenario = selectFakeProviderScenario(userPrompt, toolPrompts);
            const tool =
                requestedTool !== undefined
                    ? selectRequestedTool(tools, requestedTool)
                    : completedToolCalls < scenario.toolCalls
                      ? selectTool(
                            tools,
                            scenario,
                            completedToolCalls,
                            options.patch,
                            typeof options.readPath === "function" ? options.readPath(userPrompt) : options.readPath,
                            options.mcpImage,
                        )
                      : undefined;
            const selectedAnswer = fakeProviderResponse(answer, scenario);
            const selectedChunks = responseChunks(selectedAnswer, scenario);
            requests.push({
                model: payload["model"],
                reasoning: payload["reasoning"],
                serviceTier: payload["service_tier"],
                scenario,
                selectedTool: tool === undefined ? undefined : { kind: tool.kind, name: tool.name },
                toolResultCount: completedToolCalls,
                tools: tools.map(({ kind, name }) => ({ kind, name })),
                url: request.url ?? "",
            });
            if (options.failPromptContaining !== undefined && userPrompt.includes(options.failPromptContaining)) {
                failedMarkerRequests += 1;
                const shouldFail =
                    options.failMatchCount === undefined || failedMarkerRequests <= options.failMatchCount;
                if (shouldFail) {
                    await options.holdBeforeFailure?.();
                    response.writeHead(500, { "content-type": "application/json" });
                    response.end(
                        JSON.stringify({
                            error: { message: options.failureMessage ?? "fake compaction summarization failure" },
                        }),
                    );
                    return;
                }
            }

            if (request.url?.endsWith("/responses") === true) {
                response.writeHead(200, responseHeaders());
                if (tool === undefined) {
                    await options.beforeFirstText?.(disconnected.signal, conversation);
                    sendResponsesText(response, model, selectedAnswer, selectedChunks, options.commentary);
                } else {
                    sendResponsesToolCall(response, model, tool);
                }
                return;
            }
            if (tool === undefined) {
                await options.beforeFirstText?.(disconnected.signal, conversation);
            }
            if (payload["stream"] === false) {
                sendChatCompletion(response, model, selectedAnswer, tool);
                return;
            }
            response.writeHead(200, responseHeaders());
            if (tool === undefined) {
                sendChatText(response, model, selectedChunks);
            } else {
                sendChatToolCall(response, model, tool);
            }
        });
        server.on("upgrade", (_request, socket) => {
            socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            throw new Error("Fake OpenAI provider has no TCP address");
        }
        const close = async (): Promise<void> => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
        };
        return new FakeOpenAiProvider(
            `http://127.0.0.1:${address.port.toString()}`,
            model,
            answer,
            toolPrompts,
            requests,
            close,
        );
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#close();
    }
}
