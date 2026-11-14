import { Monitor } from "lucide-react";
import * as v from "valibot";
import { HighlightedCode } from "../highlighted-code.tsx";
import { isOversizedToolText, ToolTextPreview } from "../tool-text-preview.tsx";
import { ToolCallDisclosure } from "./tool-call-status.tsx";
import { toolTextContent } from "./tool-display-content.ts";
import type { ToolRendererProps } from "./tool-renderer.ts";

const requestSchema = v.pipe(
    v.strictObject({
        code: v.pipe(v.string(), v.minLength(1)),
        timeout_ms: v.optional(v.pipe(v.number(), v.finite(), v.minValue(1))),
        title: v.pipe(v.string(), v.minLength(1)),
    }),
    v.readonly(),
);
const responseSchema = v.pipe(v.object({ content: v.pipe(v.array(v.unknown()), v.readonly()) }), v.readonly());
const textContentSchema = v.pipe(
    v.object({
        text: v.string(),
        type: v.literal("text"),
    }),
    v.readonly(),
);

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function parseRequest(value: string): v.InferOutput<typeof requestSchema> | null {
    const request = v.safeParse(requestSchema, parseJson(value));
    return request.success ? request.output : null;
}

function responseText(value: string): string | null {
    const decoded = parseJson(value);
    if (decoded === null) {
        return "";
    }
    const response = v.safeParse(responseSchema, decoded);
    if (!response.success) {
        return null;
    }
    return response.output.content
        .flatMap((item) => {
            const content = v.safeParse(textContentSchema, item);
            return content.success ? [content.output.text] : [];
        })
        .join("\n");
}

export function matchesBrowserJavascriptToolCall(entry: ToolRendererProps["entry"]): boolean {
    return entry.name === "cua_repl/js" || parseRequest(entry.input) !== null;
}

export function BrowserJavascriptToolCall({ entry }: ToolRendererProps) {
    const request = parseRequest(entry.input);
    const title = request?.title ?? entry.title;
    const displayContent = toolTextContent(entry.content);
    const protocolResponse =
        displayContent === null && !isOversizedToolText(entry.output) ? responseText(entry.output) : null;
    const output = displayContent ?? protocolResponse ?? entry.output;
    return (
        <ToolCallDisclosure
            ariaLabel={`Browser: ${title}`}
            icon={<Monitor aria-hidden="true" className="size-4 shrink-0" />}
            state={entry.state}
            title={title}
        >
            <div className="grid min-w-0 gap-2 text-xs">
                {request !== null && (
                    <div className="overflow-hidden rounded-lg bg-black/[0.035]">
                        <HighlightedCode code={request.code} language="javascript" />
                    </div>
                )}
                {output.length > 0 && <ToolTextPreview text={output} />}
            </div>
        </ToolCallDisclosure>
    );
}
