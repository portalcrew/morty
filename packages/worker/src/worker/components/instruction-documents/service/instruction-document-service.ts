import * as v from "valibot";
import agentApiTemplate from "../../../../../../web/content/instructions/agent-api.txt?raw";
import setupTemplate from "../../../../../../web/content/instructions/setup.txt?raw";
import { agentAsyncApiDocument, agentOpenApiDocument } from "./agent-api-documents.ts";

const instructionOriginSchema = v.pipe(
    v.string(),
    v.url(),
    v.regex(/^https?:\/\/[a-zA-Z0-9.:[\]-]+$/u),
    v.check((value) => URL.canParse(value) && new URL(value).origin === value),
);

const templates = { setup: setupTemplate, agentApi: agentApiTemplate };
const schemas = { openapi: agentOpenApiDocument, asyncapi: agentAsyncApiDocument };

export type InstructionDocument = keyof typeof templates;
export type ApiSchemaDocument = keyof typeof schemas;

/** The public paths of every origin-rendered document, which the edge caches per origin. */
export const instructionDocumentPaths: ReadonlySet<string> = new Set([
    "/doc/setup.md",
    "/doc/agent-api.md",
    "/doc/agent-api/openapi.json",
    "/doc/agent-api/asyncapi.json",
]);

export function instructionOrigin(value: unknown): string | null {
    const origin = v.safeParse(instructionOriginSchema, value);
    return origin.success ? origin.output : null;
}

export function renderInstructionDocument(document: InstructionDocument, origin: string): string {
    const template = templates[document];
    return template.replaceAll("{{BASE_URL}}", origin);
}

export function renderApiSchemaDocument(document: ApiSchemaDocument, origin: string): string {
    return JSON.stringify(schemas[document](origin));
}
