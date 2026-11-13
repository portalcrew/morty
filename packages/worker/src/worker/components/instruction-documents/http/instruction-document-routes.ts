import { Hono } from "hono";
import type { CloudBindings } from "../../../../contracts/cloud-bindings.ts";
import { RequestError } from "../../../../http/request-error.ts";
import {
    type ApiSchemaDocument,
    type InstructionDocument,
    instructionOrigin,
    renderApiSchemaDocument,
    renderInstructionDocument,
} from "../service/instruction-document-service.ts";

function documentOrigin(requestUrl: string, configuredOrigin: unknown): string {
    const origin = instructionOrigin(configuredOrigin === undefined ? new URL(requestUrl).origin : configuredOrigin);
    if (origin === null) {
        throw new RequestError("INVALID_INSTRUCTION_ORIGIN", "The instruction origin is invalid.", 500);
    }
    return origin;
}

const cacheControl = "public, max-age=0, s-maxage=300";

function instruction(document: InstructionDocument, requestUrl: string, configuredOrigin: unknown): Response {
    return new Response(renderInstructionDocument(document, documentOrigin(requestUrl, configuredOrigin)), {
        headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": cacheControl },
    });
}

function apiSchema(document: ApiSchemaDocument, requestUrl: string, configuredOrigin: unknown): Response {
    return new Response(renderApiSchemaDocument(document, documentOrigin(requestUrl, configuredOrigin)), {
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": cacheControl,
            "Access-Control-Allow-Origin": "*",
        },
    });
}

export const instructionDocumentRoutes = new Hono<{ readonly Bindings: CloudBindings }>()
    .get("/doc/setup.md", (context) => instruction("setup", context.req.url, context.env.APP_ORIGIN))
    .get("/doc/agent-api.md", (context) => instruction("agentApi", context.req.url, context.env.APP_ORIGIN))
    .get("/doc/agent-api/openapi.json", (context) => apiSchema("openapi", context.req.url, context.env.APP_ORIGIN))
    .get("/doc/agent-api/asyncapi.json", (context) => apiSchema("asyncapi", context.req.url, context.env.APP_ORIGIN));
