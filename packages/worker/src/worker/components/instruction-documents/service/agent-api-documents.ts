import {
    IDENTIFIER_PATTERN,
    isDirectoryPath,
    isIdentifier,
    sessionResultJsonSchemas,
} from "@morty-build/client/protocol";
import { toJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";
import {
    type AgentApiOperation,
    type AgentApiResponse,
    agentApiOperations,
} from "../../../../contracts/agent-api/operations.ts";
import { transportFrames } from "../../../../contracts/agent-api/transport-frames.ts";

// The machine-readable agent API descriptions are generated from the schemas the Worker validates requests with, the
// schemas its responses are compiled against, and the client protocol schemas that decode Session results. Only the
// prose (summaries and descriptions) is written here and in the operation registry.

const identifierSchema = { type: "string", pattern: IDENTIFIER_PATTERN.source } as const;

function jsonSchema(schema: v.GenericSchema): Record<string, unknown> {
    const { $schema: _, ...converted } = toJsonSchema(schema, {
        errorMode: "ignore",
        target: "draft-2020-12",
        overrideSchema: (context) => {
            const candidate: unknown = context.valibotSchema;
            if (typeof candidate !== "object" || candidate === null || !("type" in candidate)) {
                return undefined;
            }
            if (candidate.type === "custom" && "check" in candidate) {
                if (candidate.check === isIdentifier) {
                    return { $ref: "#/components/schemas/Identifier" };
                }
                if (candidate.check === isDirectoryPath) {
                    return { type: "string", description: "An absolute directory on the Computer." };
                }
            }
            return undefined;
        },
    });
    return converted;
}

/**
 * A protocol schema embedded in the OpenAPI document. Its `$defs` move to `components/schemas` under a name scoped to
 * the result, because a `#/$defs/...` reference resolves against the document root.
 */
function protocolSchema(result: string, schema: object, components: Record<string, unknown>): unknown {
    const definitions =
        "$defs" in schema && typeof schema.$defs === "object" && schema.$defs !== null ? schema.$defs : {};
    const scoped = (name: string) => `${result}.${name}`;
    const rewrite = (value: unknown): unknown => {
        if (Array.isArray(value)) {
            return value.map(rewrite);
        }
        if (typeof value !== "object" || value === null) {
            return value;
        }
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key !== "$schema" && key !== "$defs")
                .map(([key, entry]) => [
                    key,
                    key === "$ref" && typeof entry === "string" && entry.startsWith("#/$defs/")
                        ? `#/components/schemas/${scoped(entry.slice("#/$defs/".length))}`
                        : rewrite(entry),
                ]),
        );
    };
    for (const [name, definition] of Object.entries(definitions)) {
        components[scoped(name)] = rewrite(definition);
    }
    return rewrite(schema);
}

function responseSchema(
    response: AgentApiResponse,
    protocol: ReturnType<typeof sessionResultJsonSchemas>,
    components: Record<string, unknown>,
): unknown {
    switch (response.kind) {
        case "schema":
            return jsonSchema(response.schema);
        case "protocol":
            return protocolSchema(response.result, protocol[response.result], components);
        case "json":
            return response.schema;
    }
}

function pathParameters(operation: AgentApiOperation) {
    const names = [...operation.path.matchAll(/\{([a-zA-Z]+)\}/gu)].map((match) => match[1] ?? "");
    const declared = new Set((operation.parameters ?? []).map((parameter) => parameter.name));
    return [
        ...names
            .filter((name) => !declared.has(name))
            .map((name) => ({
                name,
                in: "path",
                required: true,
                schema:
                    name === "computerId"
                        ? { type: "string", description: "The `computerId` returned by redeemTransfer." }
                        : { $ref: "#/components/schemas/Identifier" },
            })),
        ...(operation.parameters ?? []).map((parameter) => ({ ...parameter, required: parameter.in === "path" })),
    ];
}

const errorResponse = {
    description: "Failure. Branch on `error.code`, never on the message.",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

export function agentOpenApiDocument(origin: string) {
    const protocol = sessionResultJsonSchemas();
    const websocket = `${origin.replace(/^http/u, "ws")}/morty/api/v1/computers/{computerId}/transport`;
    const paths: Record<string, Record<string, unknown>> = {};
    const schemas: Record<string, unknown> = {};
    for (const operation of agentApiOperations) {
        const methods = paths[operation.path] ?? {};
        methods[operation.method] = {
            operationId: operation.operationId,
            summary: operation.summary,
            tags: [operation.tag],
            ...(operation.transport === "websocket" ? { "x-morty-transport": "websocket" } : {}),
            security: operation.security === "none" ? [] : [{ [operation.security]: [] }],
            parameters: pathParameters(operation),
            ...(operation.request === undefined
                ? {}
                : {
                      requestBody: {
                          required: true,
                          content: { "application/json": { schema: jsonSchema(operation.request) } },
                      },
                  }),
            responses: {
                "200": {
                    description: "Success.",
                    content: { "application/json": { schema: responseSchema(operation.response, protocol, schemas) } },
                },
                default: errorResponse,
            },
        };
        paths[operation.path] = methods;
    }
    return {
        openapi: "3.1.0",
        info: {
            title: "Morty agent API",
            version: "1",
            description: `How an AI agent operates a Computer shared with it through a continue link. Read ${origin}/doc/agent-api.md first. Operations marked \`x-morty-transport: websocket\` are not served over plain HTTPS: send them as \`http.request\` frames on ${websocket}, described in ${origin}/doc/agent-api/asyncapi.json.`,
        },
        servers: [{ url: origin }],
        tags: [
            { name: "Identity", description: "Redeem a continue link." },
            { name: "Chat", description: "Find and open Sessions. Authenticated with the Computer token." },
            { name: "Session", description: "Operate one Session through the WebSocket transport." },
        ],
        paths,
        components: {
            securitySchemes: {
                computerToken: {
                    type: "http",
                    scheme: "bearer",
                    description: "The `computerToken` redeemTransfer returns.",
                },
                sessionCredential: {
                    type: "http",
                    scheme: "bearer",
                    description:
                        "The short-lived `credential` openSession or renewSessionCredential returns. Send it inside each transport frame's headers.",
                },
            },
            schemas: {
                ...schemas,
                Identifier: identifierSchema,
                Error: {
                    type: "object",
                    required: ["error"],
                    properties: {
                        error: {
                            type: "object",
                            required: ["code", "message"],
                            properties: { code: { type: "string" }, message: { type: "string" } },
                        },
                    },
                },
            },
        },
    };
}

export function agentAsyncApiDocument(origin: string) {
    const url = new URL(origin);
    const messages = Object.fromEntries(
        Object.entries(transportFrames).map(([name, frame]) => [
            name,
            {
                name: frame.schema.entries.kind.literal,
                summary: frame.summary,
                contentType: "application/json",
                payload: jsonSchema(frame.schema),
            },
        ]),
    );
    const references = (direction: "send" | "receive") =>
        Object.entries(transportFrames)
            .filter(([, frame]) => frame.direction === direction)
            .map(([name]) => ({ $ref: `#/channels/transport/messages/${name}` }));
    const computerId = { description: "The `computerId` redeemTransfer returns." };
    return {
        asyncapi: "3.0.0",
        info: {
            title: "Morty Computer transport",
            version: "1",
            description: `JSON text frames that carry the Session operations of ${origin}/doc/agent-api/openapi.json. Each http.request frame wraps one operation: its method, path with query, headers including the Session credential, and JSON body as a string. Read ${origin}/doc/agent-api.md first.`,
        },
        servers: {
            morty: {
                host: url.host,
                protocol: url.protocol === "https:" ? "wss" : "ws",
                pathname: "/morty/api/v1/computers/{computerId}/transport",
                variables: { computerId },
            },
        },
        channels: {
            transport: {
                address: "/morty/api/v1/computers/{computerId}/transport",
                parameters: { computerId },
                messages,
            },
        },
        operations: {
            sendFrames: { action: "send", channel: { $ref: "#/channels/transport" }, messages: references("send") },
            receiveFrames: {
                action: "receive",
                channel: { $ref: "#/channels/transport" },
                messages: references("receive"),
            },
        },
    };
}
